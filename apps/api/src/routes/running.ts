// /api/running: "Läuft gerade" (TC-178…183), the caller's active time-based
// decisions across all upstreams and accesses. Mounted under /api (Authelia
// identity). Everything is scoped by the CALLER: another user's rows never
// appear and can never be ended from here.
//
//   GET    /          { pauses: live Snooze rows (allow = Zeitfreigabe, deny =
//                       Sperre), soonest end first; paused: accesses with
//                       pausedAt set (ADR-0024), oldest first;
//                       pausedUpstreams: upstreams with pausedAt set
//                       (ADR-0033), oldest first }. No arguments,
//                       no credentials: names, scope, times and the human's
//                       "Wofür?" only.
//   POST   /pauses/:id/resume
//                     ADR-0029 amendment: "Fortsetzen" of an interrupted
//                     Zeitfreigabe of the caller (still interrupted and live;
//                     the anchor stays, held calls are NOT settled). Anything
//                     else (Sperre, active, expired, unknown, foreign) -> 404.
//                     -> the GET body
//   GET    /targets   TC-281: what a Zeitfreigabe can be started on without a
//                       held call: the caller's upstreams, each with the
//                       accesses that reach it -> [{ id, name, clients }]
//   POST   /pauses    TC-281/282: { upstreamId, clientId, snoozeMinutes |
//                       snoozeUntilMidnight } starts a Zeitfreigabe on every
//                       tool of the upstream for that access (scope UPSTREAM,
//                       no anchor, no purpose: no KI-Prüfung, ADR-0041). Like
//                       any Zeitfreigabe it only turns ASK into ALLOW, never
//                       for new or changed tools. Foreign or unknown upstream
//                       or access, or an access that cannot reach the
//                       upstream -> 404. -> 201 + the GET body
//   DELETE /pauses    "Alle beenden": ends every Zeitfreigabe and Sperre of the
//                       caller (paused accesses and upstreams stay; they are
//                       resumed one by one via PATCH /api/mcp/clients/:id and
//                       PATCH /api/upstreams/:id). -> { ended: n }
//
// Ending one entry reuses DELETE /api/upstreams/:id/snoozes/:snoozeId; a change
// is announced on the approval stream as `running` (lib/pauseEvents.ts).
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { pauseEvents as defaultEvents, type PauseEvents } from '../lib/pauseEvents.js';
import { createSnooze, resumeAllowPauses } from '../approval/snooze.js';
import { MAX_SNOOZE_MINUTES, snoozeUntil } from '../approval/budget.js';
import { reachesUpstream } from './upstreamTools.js';

const NOT_FOUND = { error: 'Nicht gefunden.' };

const startSchema = z
  .object({
    upstreamId: z.number().int().positive(),
    clientId: z.number().int().positive(),
    snoozeMinutes: z.number().int().min(1).max(MAX_SNOOZE_MINUTES).optional(),
    snoozeUntilMidnight: z.literal(true).optional(),
  })
  .strict()
  // Exactly one duration.
  .refine((b) => (b.snoozeMinutes !== undefined) !== (b.snoozeUntilMidnight === true));

export function makeRunningRoutes(clock: Clock = systemClock, events: PauseEvents = defaultEvents) {
  const r = new Hono<AppEnv>();

  r.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  async function view(userId: number) {
    const now = clock.now();
    const [rows, clients, upstreams] = await Promise.all([
      prisma.snooze.findMany({
        where: { userId, until: { gt: now } },
        select: {
          id: true,
          effect: true,
          scope: true,
          toolName: true,
          until: true,
          createdAt: true,
          purpose: true,
          purposeSource: true,
          suspendedAt: true,
          upstream: { select: { id: true, name: true } },
          mcpClient: { select: { id: true, name: true } },
        },
        orderBy: [{ until: 'asc' }, { id: 'asc' }],
      }),
      prisma.mcpClient.findMany({
        where: { userId, pausedAt: { not: null } },
        select: { id: true, name: true, pausedAt: true },
        orderBy: [{ pausedAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.upstream.findMany({
        where: { userId, pausedAt: { not: null } },
        select: { id: true, name: true, pausedAt: true },
        orderBy: [{ pausedAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      pauses: rows.map((p) => ({
        id: p.id,
        // Anything but exactly ALLOW is a Sperre (snooze.ts isAllow).
        effect: p.effect === 'ALLOW' ? ('ALLOW' as const) : ('DENY' as const),
        scope: p.scope,
        toolName: p.toolName,
        upstream: p.upstream,
        client: p.mcpClient,
        until: p.until.toISOString(),
        createdAt: p.createdAt.toISOString(),
        purpose: p.purpose,
        purposeSource: p.purpose ? (p.purposeSource === 'suggested' ? 'suggested' : 'typed') : null,
        // ADR-0029 amendment: interrupted by the KI-Prüfung (null = active).
        suspendedAt: p.suspendedAt?.toISOString() ?? null,
      })),
      paused: clients.map((cl) => ({ id: cl.id, name: cl.name, pausedAt: cl.pausedAt!.toISOString() })),
      pausedUpstreams: upstreams.map((u) => ({ id: u.id, name: u.name, pausedAt: u.pausedAt!.toISOString() })),
    };
  }

  r.get('/', async (c) => c.json(await view(c.get('user').id)));

  r.get('/targets', async (c) => {
    const userId = c.get('user').id;
    const upstreams = await prisma.upstream.findMany({
      where: { userId },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const withClients = await Promise.all(
      upstreams.map(async (u) => ({
        ...u,
        clients: await prisma.mcpClient.findMany({
          where: { userId, OR: reachesUpstream(u.id) },
          select: { id: true, name: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
      })),
    );
    return c.json(withClients);
  });

  r.post('/pauses', async (c) => {
    const userId = c.get('user').id;
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Bitte Upstream, Zugang und eine Dauer wählen.' }, 400);
    const body = parsed.data;
    const [upstream, client] = await Promise.all([
      prisma.upstream.findFirst({ where: { id: body.upstreamId, userId }, select: { id: true } }),
      prisma.mcpClient.findFirst({ where: { id: body.clientId, userId, OR: reachesUpstream(body.upstreamId) }, select: { id: true } }),
    ]);
    if (!upstream || !client) return c.json(NOT_FOUND, 404);
    const now = clock.now();
    const until = snoozeUntil(now, body);
    if (!until) return c.json({ error: 'Bitte Upstream, Zugang und eine Dauer wählen.' }, 400);
    // No anchor, no purpose: blind (pausecheck/gate.ts). Emits `running`.
    await createSnooze({ userId, upstreamId: upstream.id, mcpClientId: client.id }, 'UPSTREAM', '', until, now, 'ALLOW');
    return c.json(await view(userId), 201);
  });

  r.post('/pauses/:id/resume', async (c) => {
    const userId = c.get('user').id;
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'Nicht gefunden.' }, 404);
    // Only the caller's interrupted, live ALLOW rows (resumeAllowPauses
    // filters); the anchor stays. Emits `running` itself.
    const resumed = await resumeAllowPauses(userId, [id], clock.now());
    if (resumed.length === 0) return c.json({ error: 'Nicht gefunden.' }, 404);
    return c.json(await view(userId));
  });

  r.delete('/pauses', async (c) => {
    const userId = c.get('user').id;
    const ended = await prisma.snooze.count({ where: { userId, until: { gt: clock.now() } } });
    // Expired rows of the caller go too (they are inert anyway).
    await prisma.snooze.deleteMany({ where: { userId } });
    events.emit({ userId });
    return c.json({ ended });
  });

  return r;
}

export const running = makeRunningRoutes();
