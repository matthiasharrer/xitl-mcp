// Web Push plumbing (ADR-0009), copied from haushalts-todos' lib/push.ts and
// adapted: payloads are typed messages the service worker (apps/web/public/
// sw.js) turns into notifications, and each send carries TTL + urgency. The
// sender is DB-free (callbacks injected), so it unit-tests without Prisma; the
// DB-backed defaults are imported lazily.
//
// The push sender is a seam (ADR-0003): PUSH_OUTBOX=<file> swaps the real
// web-push transport for an append-only JSONL file (e2e reads it).
import fs from 'node:fs';
import webpush from 'web-push';
import { pushAgentFor } from './outbound.js';

/** Web Push payloads must stay well below the ~4 KB service limit. */
export const MAX_PAYLOAD_BYTES = 4000;

/** What the service worker understands. Never upstream credentials. */
export type PushMessage =
  | {
      type: 'approval';
      id: string;
      upstream: string;
      tool: string;
      summary: string;
      /** ISO time the call stops waiting. */
      expiresAt: string;
    }
  | {
      /** The call was decided elsewhere (page), timed out, or ended because its
       * client was revoked / its upstream removed, or its client paused
       * (ADR-0024): replace the notification. */
      type: 'resolved';
      id: string;
      outcome: 'approved' | 'denied' | 'expired' | 'revoked' | 'paused';
    }
  | {
      /** ADR-0022: an upstream became unreachable / needs a reconnect (tag upstream-<id>). */
      type: 'upstream';
      upstreamId: number;
      name: string;
      state: 'unreachable' | 'reconnect';
    }
  | { type: 'test'; title: string; body: string };

export interface SendOptions {
  /** Seconds the push service keeps trying to deliver. */
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
}

export interface PushSub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one payload to one subscription; rejects on failure (with `statusCode` when the push service answered). */
export type Transport = (sub: PushSub, payload: PushMessage, opts: SendOptions) => Promise<void>;

export interface SenderDeps {
  transport: Transport;
  /** The push service said 404/410: the subscription is dead. */
  onGone: (sub: PushSub) => Promise<void>;
  onSuccess: (sub: PushSub) => Promise<void>;
  log: (message: string, err?: unknown) => void;
}

// ---- VAPID -------------------------------------------------------------------

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapidCache: VapidKeys | null = null;

/** The key pair from AppSetting "vapid"; generated and stored on first use. */
export async function getVapid(): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  const { prisma } = await import('../db.js');
  const row = await prisma.appSetting.findUnique({ where: { key: 'vapid' } });
  if (row) {
    vapidCache = JSON.parse(row.value) as VapidKeys;
    return vapidCache;
  }
  const generated = webpush.generateVAPIDKeys();
  // Two first requests racing: the unique key makes the loser read the winner's pair.
  try {
    await prisma.appSetting.create({ data: { key: 'vapid', value: JSON.stringify(generated) } });
    vapidCache = generated;
  } catch {
    const winner = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'vapid' } });
    vapidCache = JSON.parse(winner.value) as VapidKeys;
  }
  return vapidCache;
}

function vapidSubject(): string {
  return process.env.PUBLIC_URL?.trim() || 'mailto:xitl@example.invalid';
}

// ---- transports --------------------------------------------------------------

/** Appends `{endpoint, payload, ttl, urgency}` as one JSON line to `file`; sends nothing (e2e). */
export function outboxTransport(file: string): Transport {
  return async (sub, payload, opts) => {
    fs.appendFileSync(file, JSON.stringify({ endpoint: sub.endpoint, payload, ttl: opts.ttl, urgency: opts.urgency }) + '\n');
  };
}

// The endpoint is browser-supplied: the request goes through the outbound
// address policy (ADR-0020) via an https.Agent with a guarded DNS lookup
// (pushAgentFor throws OutboundBlocked for a blocked IP literal).
const webPushTransport: Transport = async (sub, payload, opts) => {
  const agent = pushAgentFor(sub.endpoint);
  const keys = await getVapid();
  await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    {
      vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: opts.ttl,
      urgency: opts.urgency,
      timeout: 10_000,
      agent,
    },
  );
};

export function defaultTransport(): Transport {
  const outbox = process.env.PUSH_OUTBOX;
  return outbox ? outboxTransport(outbox) : webPushTransport;
}

// ---- sender ------------------------------------------------------------------

async function defaultDeps(): Promise<SenderDeps> {
  const { prisma } = await import('../db.js');
  return {
    transport: defaultTransport(),
    onGone: async (sub) => {
      await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
    },
    onSuccess: async (sub) => {
      await prisma.pushSubscription.updateMany({ where: { id: sub.id }, data: { lastSuccessAt: new Date() } });
    },
    // Error class/code only: a push service error can echo the endpoint URL.
    log: (message, err) => console.error(message, err instanceof Error ? `${err.name}${(err as { statusCode?: number }).statusCode ? ` ${(err as { statusCode?: number }).statusCode}` : ''}` : ''),
  };
}

/** One device that didn't get the push: the push service's HTTP status, or the network error code. */
export interface SendFailure {
  subId: number;
  status?: number;
  code?: string;
}

/** German explanation of a failure, for "Test-Push" (the only caller who waits for the answer). */
export function describeFailure(f: SendFailure): string {
  if (f.status === 404 || f.status === 410) {
    return 'Dieses Gerät ist beim Push-Dienst nicht mehr angemeldet. Schalte „Auf diesem Gerät“ aus und wieder ein.';
  }
  if (f.status) return `Der Push-Dienst hat abgelehnt (HTTP ${f.status}).`;
  return `Push-Dienst nicht erreichbar${f.code ? ` (${f.code})` : ''}. Darf der Server ins Internet (z. B. fcm.googleapis.com:443)?`;
}

/** Byte size of a payload as sent. */
export const payloadBytes = (payload: PushMessage) => Buffer.byteLength(JSON.stringify(payload), 'utf8');

/**
 * Best effort, never throws: one failing device doesn't stop the others.
 * 404/410 deletes the subscription; any other error is logged and the row kept.
 * A payload over MAX_PAYLOAD_BYTES is not sent at all (callers keep it small).
 * Returns the failures, so a caller that waits (the test push) can report them.
 */
export async function sendToSubscriptions(
  subs: PushSub[],
  payload: PushMessage,
  opts: SendOptions,
  deps?: SenderDeps,
): Promise<SendFailure[]> {
  const failures: SendFailure[] = [];
  if (subs.length === 0) return failures;
  const d = deps ?? (await defaultDeps());
  if (payloadBytes(payload) > MAX_PAYLOAD_BYTES) {
    d.log(`push payload too large (${payloadBytes(payload)} bytes), not sent`);
    return subs.map((s) => ({ subId: s.id, code: 'PAYLOAD_TOO_LARGE' }));
  }
  const ttl = Math.max(0, Math.floor(opts.ttl));
  for (const sub of subs) {
    try {
      await d.transport(sub, payload, { ...opts, ttl });
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      const code = (err as { code?: unknown } | null)?.code;
      failures.push({ subId: sub.id, status, code: typeof code === 'string' ? code : undefined });
      try {
        if (status === 404 || status === 410) {
          await d.onGone(sub);
        } else {
          d.log(`push to subscription ${sub.id} failed${status ? ` (${status})` : ''}`, err);
        }
      } catch (inner) {
        d.log(`push cleanup for subscription ${sub.id} failed`, inner);
      }
      continue;
    }
    try {
      await d.onSuccess(sub);
    } catch (err) {
      d.log(`recording push success for subscription ${sub.id} failed`, err);
    }
  }
  return failures;
}
