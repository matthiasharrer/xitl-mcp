// The process-wide pause check gate (ADR-0029) and the outage push. Env is
// read here, after db.ts loaded `.env` (gate.ts imports it first).
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { sendToSubscriptions, type SenderDeps } from '../lib/push.js';
import { PushCooldown, UPSTREAM_PUSH_COOLDOWN_MS, UPSTREAM_PUSH_TTL_S } from '../upstream/notify.js';
import { pauseCheckFromEnv } from './check.js';
import { PauseGate } from './gate.js';
import type { PauseCheckOutage } from './outage.js';

export const pauseGate = new PauseGate(pauseCheckFromEnv());

/** One push per outage start, at most one per user per hour (ADR-0022's
 * cooldown): {type:'pausecheck', state:'unreachable'}, no error text. */
export function wirePauseCheckPush(outage: PauseCheckOutage = pauseGate.outage, opts: { clock?: Clock; deps?: SenderDeps } = {}): () => void {
  const cooldown = new PushCooldown(opts.clock ?? systemClock, UPSTREAM_PUSH_COOLDOWN_MS);
  return outage.on((ev) => {
    if (!ev.started || !cooldown.take(ev.userId)) return;
    void (async () => {
      const subs = await prisma.pushSubscription.findMany({
        where: { userId: ev.userId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      await sendToSubscriptions(subs, { type: 'pausecheck', state: 'unreachable' }, { ttl: UPSTREAM_PUSH_TTL_S, urgency: 'normal' }, opts.deps);
    })().catch((e) => console.error('pause check push failed', e instanceof Error ? e.name : ''));
  });
}
