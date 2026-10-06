// Which calls share one intent context (ADR-0025 §3): ADR-0019's grouping,
// the same rule the UI uses (apps/web/src/lib/grouping.ts). Pure, unit tested
// (TC-109).
//
// - A call with an MCP session belongs with the other calls of that session.
// - A sessionless call belongs with the previous sessionless call of the same
//   MCP client if at most GROUP_GAP_MS lie between them (Claude.ai sends no
//   sessions, so this is what "the chat" means for it).

/** Same value as the UI's GROUP_GAP_MS. */
export const GROUP_GAP_MS = 10 * 60 * 1000;

export interface GroupRef {
  sessionId: string | null;
  mcpClientId: number | null;
  receivedAt: Date;
}

/** Where a call comes from: its session, else its client. Calls of one
 * source are summarized strictly in order. */
export function sourceKey(r: Pick<GroupRef, 'sessionId' | 'mcpClientId'>): string {
  if (r.sessionId) return `s:${r.sessionId}`;
  return r.mcpClientId !== null ? `c:${r.mcpClientId}` : 'none';
}

/** Does `next` continue the group of `prev` (its predecessor in the source)? */
export function continuesGroup(prev: GroupRef, next: GroupRef, gapMs = GROUP_GAP_MS): boolean {
  if (sourceKey(prev) !== sourceKey(next) || sourceKey(next) === 'none') return false;
  if (next.sessionId) return true;
  return next.receivedAt.getTime() - prev.receivedAt.getTime() <= gapMs;
}
