// Push channel for held calls (ADR-0009): listens on the ApprovalHub and sends
// to the OWNING user's subscriptions only. Never throws into the hub; a push
// problem must not affect the decision path (the page still works).
//
// - 'pending'  -> {type:'approval', id, upstream, tool, summary, expiresAt},
//                 urgency high, TTL = seconds until the deadline.
// - 'intent'   -> ADR-0025: the summary of a still-held call is there: the
//                 'approval' message again with update:true, intent, risk
//                 (sw.js replaces the open notification silently, or drops it).
// - 'resolved' -> {type:'resolved', id, outcome} when the call was decided on
//                 the page, expired, or ended because its client was revoked
//                 / its upstream removed ('revoked') or its client paused
//                 ('paused', ADR-0024), so the service worker can replace the
//                 now-stale notification (tag `approval-<id>`). Not sent when
//                 the decision came from the notification itself (the SW has
//                 already replaced it) or on abort/shutdown. A 'flood' call
//                 was never announced (no 'pending'), so there is nothing to
//                 replace.
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { sendToSubscriptions, type SenderDeps } from '../lib/push.js';
import { approvalMessage, approvalUpdateMessage } from './message.js';
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

  hub.on('intent', (call: PendingCall) => {
    const msg = approvalUpdateMessage(call);
    if (!msg) return;
    void (async () => {
      const ttl = Math.max(1, Math.ceil((call.deadline.getTime() - clock.now().getTime()) / 1000));
      await sendToSubscriptions(await subsOf(call.userId), msg, { ttl, urgency: 'normal' }, opts.deps);
    })().catch((e) => console.error('intent push failed', e instanceof Error ? e.name : ''));
  });

  hub.on('resolved', (ev: ResolvedEvent) => {
    const d = ev.decision;
    let outcome: 'approved' | 'denied' | 'expired' | 'revoked' | 'paused';
    if (d.kind === 'approve' && (d.via === 'page' || d.via === 'pause')) outcome = 'approved';
    else if (d.kind === 'deny' && (d.via === 'page' || d.via === 'pause')) outcome = 'denied';
    else if (d.kind === 'timeout') outcome = 'expired';
    else if (d.kind === 'revoked' || d.kind === 'paused') outcome = d.kind;
    else return;
    void (async () => {
      await sendToSubscriptions(await subsOf(ev.userId), { type: 'resolved', id: ev.id, outcome }, { ttl: 60, urgency: 'normal' }, opts.deps);
    })().catch((e) => console.error('resolved push failed', e instanceof Error ? e.name : ''));
  });
}
