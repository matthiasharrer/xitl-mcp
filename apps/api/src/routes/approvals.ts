// /api/approvals: the human side of held calls (ADR-0004, ADR-0009, TC-27…33).
// Mounted under /api (Sec-Fetch-Site guard + Authelia identity). Everything is
// scoped by the CALLER: another user's call id is a 404 exactly like an
// unknown one, and the live stream only ever carries the caller's own events.
//
//   GET  /            my pending calls
//   GET  /stream      SSE: `snapshot` (my pending list) on connect, then
//                     `pending` / `resolved` events for my calls only
//   GET  /:id         one call: pending, or its outcome once resolved
//   POST /:id         { decision: 'approve'|'deny', via: 'page'|'push',
//                       snoozeMinutes? | snoozeUntilMidnight? }
//                     -> 200 { state }, 404 unknown/foreign, 409 no longer open
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { approvals as defaultHub, ApprovalHub, type PendingCall, type ResolvedEvent } from '../approval/pending.js';
import { MAX_SNOOZE_MINUTES, snoozeUntil } from '../approval/budget.js';
import { MAX_APPROVAL_STREAMS_PER_USER } from '../lib/limits.js';

const NOT_FOUND = { error: 'Nicht gefunden.' };
const GONE = { error: 'Diese Freigabe ist nicht mehr offen.' };
const KEEPALIVE_MS = 25_000;

const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    via: z.enum(['page', 'push']),
    snoozeMinutes: z.number().int().min(1).max(MAX_SNOOZE_MINUTES).optional(),
    snoozeUntilMidnight: z.boolean().optional(),
  })
  .strict();

/** What the UI sees of a pending call. `remainingMs` lets the client run its
 * countdown without trusting its own clock against ours. */
export function serializePending(call: PendingCall, now: Date) {
  return {
    id: call.id,
    state: 'pending' as const,
    clientName: call.clientName,
    upstream: { id: call.upstreamId, slug: call.upstreamSlug, name: call.upstreamName },
    tool: call.toolName,
    arguments: call.args,
    rulePath: call.rulePath,
    receivedAt: call.receivedAt.toISOString(),
    expiresAt: call.deadline.toISOString(),
    remainingMs: Math.max(0, call.deadline.getTime() - now.getTime()),
    snoozable: call.snoozable,
    session: call.session ? { id: call.session.id, createdAt: call.session.createdAt.toISOString() } : null,
  };
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The outcome of a call that is no longer pending (from its audit row). */
async function resolvedView(userId: number, id: string) {
  const a = await prisma.auditEntry.findFirst({
    where: { approvalId: id, userId },
    include: {
      mcpClient: { select: { name: true } },
      upstream: { select: { id: true, slug: true, name: true } },
      session: { select: { id: true, createdAt: true } },
    },
  });
  if (!a) return null;
  return {
    id,
    state: 'resolved' as const,
    auditId: a.id,
    outcome: a.outcome,
    decisionPath: a.decisionPath,
    clientName: a.mcpClient?.name ?? null,
    upstream: a.upstream,
    tool: a.toolName,
    arguments: parseArgs(a.arguments),
    receivedAt: a.receivedAt.toISOString(),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    session: a.session ? { id: a.session.id, createdAt: a.session.createdAt.toISOString() } : null,
  };
}

export function makeApprovalRoutes(
  hub: ApprovalHub = defaultHub,
  clock: Clock = systemClock,
  opts: { maxStreamsPerUser?: number } = {},
) {
  const r = new Hono<AppEnv>();
  const maxStreams = opts.maxStreamsPerUser ?? MAX_APPROVAL_STREAMS_PER_USER;
  /** Open streams per user (TC-45). */
  const openStreams = new Map<number, number>();

  r.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  r.get('/', (c) => {
    const now = clock.now();
    return c.json(hub.list(c.get('user').id).map((p) => serializePending(p, now)));
  });

  r.get('/stream', (c) => {
    const userId = c.get('user').id;
    const openCount = openStreams.get(userId) ?? 0;
    if (openCount >= maxStreams) return c.json({ error: 'Zu viele offene Verbindungen.' }, 429);
    // Counted synchronously here, released in the stream callback's finally
    // (streamSSE starts the callback at once; it ends on abort/shutdown/error).
    openStreams.set(userId, openCount + 1);
    const release = () => {
      const n = (openStreams.get(userId) ?? 1) - 1;
      if (n <= 0) openStreams.delete(userId);
      else openStreams.set(userId, n);
    };
    // Proxies (nginx-style) must not buffer the stream.
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let open = true;
      let wake: (() => void) | null = null;
      const queue: { event: string; data: string }[] = [];
      const push = (event: string, data: unknown) => {
        queue.push({ event, data: JSON.stringify(data) });
        wake?.();
      };
      const onPending = (call: PendingCall) => {
        if (call.userId === userId) push('pending', serializePending(call, clock.now()));
      };
      const onResolved = (ev: ResolvedEvent) => {
        if (ev.userId === userId) push('resolved', { id: ev.id, kind: ev.decision.kind });
      };
      const close = () => {
        open = false;
        wake?.();
      };
      hub.on('pending', onPending);
      hub.on('resolved', onResolved);
      hub.on('shutdown', close);
      stream.onAbort(close);
      c.req.raw.signal?.addEventListener('abort', close, { once: true });
      try {
        const now = clock.now();
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(hub.list(userId).map((p) => serializePending(p, now))) });
        while (open) {
          while (queue.length > 0 && open) {
            const next = queue.shift()!;
            await stream.writeSSE(next);
          }
          if (!open) break;
          const timedOut = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(true), KEEPALIVE_MS);
            wake = () => {
              clearTimeout(t);
              resolve(false);
            };
          });
          wake = null;
          if (timedOut && open) await stream.write(': keepalive\n\n');
        }
      } finally {
        hub.off('pending', onPending);
        hub.off('resolved', onResolved);
        hub.off('shutdown', close);
        release();
      }
    });
  });

  r.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ApprovalHub.isId(id)) return c.json(NOT_FOUND, 404);
    const userId = c.get('user').id;
    const pending = hub.get(userId, id);
    if (pending) return c.json(serializePending(pending, clock.now()));
    const done = await resolvedView(userId, id);
    return done ? c.json(done) : c.json(NOT_FOUND, 404);
  });

  r.post('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ApprovalHub.isId(id)) return c.json(NOT_FOUND, 404);
    const userId = c.get('user').id;
    const parsed = decisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Die Entscheidung ist ungültig.' }, 400);
    const body = parsed.data;

    const pending = hub.get(userId, id);
    if (!pending) {
      // Not open (any more). Ours -> 409; unknown or someone else's -> 404.
      const mine = await prisma.auditEntry.findFirst({ where: { approvalId: id, userId }, select: { id: true } });
      return mine ? c.json(GONE, 409) : c.json(NOT_FOUND, 404);
    }

    const wantsSnooze = body.snoozeMinutes !== undefined || body.snoozeUntilMidnight === true;
    if (body.decision === 'deny' && wantsSnooze) return c.json({ error: 'Pausieren geht nur beim Erlauben.' }, 400);
    if (wantsSnooze && !pending.snoozable) {
      return c.json({ error: 'Neue oder geänderte Tools lassen sich nicht pausieren. Bitte zuerst in den Regeln ansehen.' }, 400);
    }
    const until = body.decision === 'approve' ? snoozeUntil(clock.now(), body) : null;

    const result =
      body.decision === 'approve'
        ? hub.decide(userId, id, { kind: 'approve', via: body.via, snoozeUntil: until })
        : hub.decide(userId, id, { kind: 'deny', via: body.via });
    // Lost the race against the deadline / another device between get and decide.
    if (result !== 'ok') return c.json(GONE, 409);
    return c.json({ id, state: body.decision === 'approve' ? 'approved' : 'denied', snoozeUntil: until?.toISOString() ?? null });
  });

  return r;
}

export const approvalRoutes = makeApprovalRoutes();
