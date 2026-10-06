// The process-wide intent queue (ADR-0025) and its wiring to the approval hub.
// Env is read here, after db.ts loaded `.env` (store.ts imports it first).
import { approvals, type ApprovalHub, type ResolvedEvent } from '../approval/pending.js';
import { intentModelFromEnv, intentTimeoutFromEnv } from './model.js';
import type { IntentEvent, IntentQueue } from './queue.js';
import { makeIntentQueue } from './store.js';

export const intents: IntentQueue = makeIntentQueue({
  model: intentModelFromEnv(),
  timeoutMs: intentTimeoutFromEnv(process.env.INTENT_LLM_TIMEOUT_MS),
});

/** A decided call loses its priority; a summary of a still-held call is
 * attached to it (SSE `intent`, replacement push). The hub never lets it
 * influence a decision. */
export function wireIntents(queue: IntentQueue = intents, hub: ApprovalHub = approvals): void {
  hub.on('resolved', (ev: ResolvedEvent) => queue.release(ev.id));
  queue.on('intent', (ev: IntentEvent) => {
    if (ev.approvalId) hub.setIntent(ev.userId, ev.approvalId, ev.view);
  });
}
