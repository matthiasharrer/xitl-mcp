// The push payload for a held call (ADR-0009, TC-32). Pure: unit tested.
import type { PushMessage } from '../lib/push.js';

type ApprovalPush = Extract<PushMessage, { type: 'approval' }>;
import { approvalSummary } from './budget.js';
import type { PendingCall } from './pending.js';
import { MAX_INTENT_PUSH_CHARS, MAX_INTENT_TITLE_CHARS } from '../lib/limits.js';

const MAX_UPSTREAM = 80;
const MAX_TOOL = 100;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** id, upstream name, tool, a short summary and the deadline. Nothing else:
 * no client name, no full arguments, never an upstream credential. */
export function approvalMessage(call: Pick<PendingCall, 'id' | 'upstreamName' | 'toolName' | 'args' | 'deadline'>): ApprovalPush {
  return {
    type: 'approval',
    id: call.id,
    upstream: cut(call.upstreamName, MAX_UPSTREAM),
    tool: cut(call.toolName, MAX_TOOL),
    summary: approvalSummary(call.toolName, call.args),
    expiresAt: call.deadline.toISOString(),
  };
}

/** ADR-0025: the replacement push once the summary is there (same id, so the
 * same notification tag): `update`, the intent (≤ 200 chars) and the shown
 * risk. null when there is no summary to show. */
export function approvalUpdateMessage(
  call: Pick<PendingCall, 'id' | 'upstreamName' | 'toolName' | 'args' | 'deadline' | 'intent'>,
): ApprovalPush | null {
  const i = call.intent;
  if (!i || i.status !== 'DONE' || !i.summary || !i.risk) return null;
  return {
    ...approvalMessage(call),
    update: true,
    intent: cut(i.summary, MAX_INTENT_PUSH_CHARS),
    ...(i.title ? { intentTitle: cut(i.title, MAX_INTENT_TITLE_CHARS) } : {}),
    risk: i.risk,
  };
}
