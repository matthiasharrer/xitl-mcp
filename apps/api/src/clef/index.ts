// The process-wide Clef config and the background tool labeller (ADR-0031).
// Env is read here, after db.ts loaded `.env` (imported first). The AI check
// of allow pauses (pausecheck/index.ts) and the AUTO gate (auto/index.ts)
// use the same env, so all three talk to one Clef endpoint and share one
// per-user switch (User.pauseCheck) and one outage notice.
import '../db.js';
import { onToolsSynced } from '../upstream/tools.js';
import { clefFromEnv } from './client.js';
import { HintQueue } from '../toolhint/queue.js';

export const clefConfig = clefFromEnv(process.env, (l) => console.error(l));

export const toolHints = new HintQueue(clefConfig);

/** Labels new/changed tools after every sync (fire and forget). */
export function wireToolHints(queue: HintQueue = toolHints): () => void {
  return onToolsSynced((upstreamId) => void queue.schedule(upstreamId));
}
