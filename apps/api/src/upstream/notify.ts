// Push channel for upstream faults (ADR-0022): on a transition INTO
// `unreachable` or `reconnect` (upstream/stateEvents.ts), the owning user's
// devices get {type:'upstream', upstreamId, name, state}: the display name and
// the state, never an error text, URL, status code or credential (ADR-0007).
// No push on recovery or on edits. At most one push per upstream per hour
// (in memory, single replica), so a flapping upstream doesn't spam. Never
// throws into the emitter (the contact path). A paused upstream (ADR-0033) is
// never pushed about (a contact still in flight when it was paused can end
// in a failure transition).
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { sendToSubscriptions, type SenderDeps } from '../lib/push.js';
import type { UpstreamStateEvents } from './stateEvents.js';

export const UPSTREAM_PUSH_COOLDOWN_MS = 60 * 60 * 1000;
/** The push service may hold it this long; after that the card on Freigaben tells. */
export const UPSTREAM_PUSH_TTL_S = 60 * 60;

/** "At most one per key per window", keyed by upstream id. Pure apart from the Clock. */
export class PushCooldown {
  private last = new Map<number, number>();
  constructor(
    private clock: Clock,
    private windowMs = UPSTREAM_PUSH_COOLDOWN_MS,
  ) {}

  /** True (and the window starts) when `key` may push now. */
  take(key: number): boolean {
    const now = this.clock.now().getTime();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.last.set(key, now);
    // Forget expired entries so the map stays as small as the live faults.
    for (const [k, t] of this.last) if (now - t >= this.windowMs) this.last.delete(k);
    return true;
  }
}

export function wireUpstreamPush(states: UpstreamStateEvents, opts: { clock?: Clock; deps?: SenderDeps } = {}): () => void {
  const cooldown = new PushCooldown(opts.clock ?? systemClock);
  return states.on((ev) => {
    if (ev.cause !== 'transition' || (ev.state !== 'unreachable' && ev.state !== 'reconnect')) return;
    const state = ev.state;
    if (!cooldown.take(ev.upstreamId)) return;
    void (async () => {
      const upstream = await prisma.upstream.findFirst({ where: { id: ev.upstreamId, userId: ev.userId }, select: { id: true, name: true, pausedAt: true } });
      if (!upstream || upstream.pausedAt !== null) return;
      const subs = await prisma.pushSubscription.findMany({
        where: { userId: ev.userId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      await sendToSubscriptions(
        subs,
        { type: 'upstream', upstreamId: upstream.id, name: upstream.name, state },
        { ttl: UPSTREAM_PUSH_TTL_S, urgency: 'normal' },
        opts.deps,
      );
    })().catch((e) => console.error('upstream push failed', e instanceof Error ? e.name : ''));
  });
}
