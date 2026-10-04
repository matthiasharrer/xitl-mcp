// The push payload for a held call (ADR-0009, TC-32). Pure: unit tested.
import type { PushMessage } from '../lib/push.js';
import { approvalSummary } from './budget.js';
import type { PendingCall } from './pending.js';

const MAX_UPSTREAM = 80;
const MAX_TOOL = 100;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** id, upstream name, tool, a short summary and the deadline. Nothing else:
 * no client name, no full arguments, never an upstream credential. */
export function approvalMessage(call: Pick<PendingCall, 'id' | 'upstreamName' | 'toolName' | 'args' | 'deadline'>): PushMessage {
  return {
    type: 'approval',
    id: call.id,
    upstream: cut(call.upstreamName, MAX_UPSTREAM),
    tool: cut(call.toolName, MAX_TOOL),
    summary: approvalSummary(call.toolName, call.args),
    expiresAt: call.deadline.toISOString(),
  };
}
