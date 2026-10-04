// Push channel for held calls (ADR-0009): listens on the ApprovalHub and sends
// to the OWNING user's subscriptions only. Never throws into the hub; a push
// problem must not affect the decision path (the page still works).
//
// - 'pending'  -> {type:'approval', id, upstream, tool, summary, expiresAt},
//                 urgency high, TTL = seconds until the deadline.
// - 'resolved' -> {type:'resolved', id, outcome} when the call was decided on
//                 the page or expired, so the service worker can replace the
//                 now-stale notification (tag `approval-<id>`). Not sent when
//                 the decision came from the notification itself (the SW has
//                 already replaced it) or on abort/shutdown.
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { sendToSubscriptions, type SenderDeps } from '../lib/push.js';
import { approvalMessage } from './message.js';
import type { ApprovalHub, PendingCall, ResolvedEvent } from './pending.js';

async function subsOf(userId: number) {
  return prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
}

export function wireApprovalPush(hub: ApprovalHub, opts: { clock?: Clock; deps?: SenderDeps } = {}): void {
  const clock = opts.clock ?? systemClock;

  hub.on('pending', (call: PendingCall) => {
    void (async () => {
      const ttl = Math.max(1, Math.ceil((call.deadline.getTime() - clock.now().getTime()) / 1000));
      await sendToSubscriptions(await subsOf(call.userId), approvalMessage(call), { ttl, urgency: 'high' }, opts.deps);
    })().catch((e) => console.error('approval push failed', e instanceof Error ? e.name : ''));
  });

  hub.on('resolved', (ev: ResolvedEvent) => {
    const d = ev.decision;
    let outcome: 'approved' | 'denied' | 'expired';
    if (d.kind === 'approve' && d.via === 'page') outcome = 'approved';
    else if (d.kind === 'deny' && d.via === 'page') outcome = 'denied';
    else if (d.kind === 'timeout') outcome = 'expired';
    else return;
    void (async () => {
      await sendToSubscriptions(await subsOf(ev.userId), { type: 'resolved', id: ev.id, outcome }, { ttl: 60, urgency: 'normal' }, opts.deps);
    })().catch((e) => console.error('resolved push failed', e instanceof Error ? e.name : ''));
  });
}
