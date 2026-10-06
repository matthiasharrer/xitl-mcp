// The policy engine (ADR-0004): ONE pure function that decides what happens to
// a tools/call (and whether/how a tool is listed). No DB, no clock, no I/O: the
// caller loads the rows and passes them in, so every precedence rule is
// unit-tested (policy.test.ts, TC-24).
//
// Precedence, first match wins:
//   1. tool unknown (not in KnownTool)      -> DENY  "unknown-tool"
//   2. a live DENY pause covers the call    -> DENY  "snooze-deny" (ADR-0026)
//      (for this client + upstream + tool, matched in approval/snooze.ts).
//      Beats everything below: client/tool ALLOW, the upstream default, an
//      allow pause, new and changed tools. It only ever tightens.
//   3. per-client override                  -> it    "policy:client"
//   4. per-tool policy                      -> it    "policy:tool"
//      ...except that a CHANGED tool (its definition changed after xitl first
//      recorded it, `changedAt` set; rug pull, TC-36) never resolves to ALLOW:
//      an explicit ALLOW at 3. or 4. becomes ASK "changed-tool" (Matthias,
//      2026-10-04). An explicit ASK or DENY applies unchanged.
//   5. tool changed (see above), no rule    -> ASK   "changed-tool"
//   6. tool not yet acknowledged (new)      -> ASK   "new-tool"
//   7. the upstream's default               -> it    "policy:upstream-default"
// Then one post-step (ADR-0004 allow snooze, TC-30):
//   8. result is ASK, the tool is NOT awaiting review (new or changed, see
//      `awaitingReview`), and a snooze for (this client, this tool) is live
//      at `now`                             -> ALLOW "snooze"
//   An allow snooze only ever upgrades ASK. Never DENY, never an unknown tool, and
//   never a new or changed tool, whatever path said ASK: those must be looked
//   at in the rules first, so a snooze set before a tool changed under us
//   cannot carry over.
//
// Fail closed: anything that is not a recognised Policy value is treated as
// DENY (a corrupted row must never become ALLOW).

export type Policy = 'ALLOW' | 'ASK' | 'DENY';

export type DecisionPath =
  | 'unknown-tool'
  | 'policy:client'
  | 'policy:tool'
  | 'changed-tool'
  | 'new-tool'
  | 'policy:upstream-default'
  | 'snooze'
  | 'snooze-deny';

export interface PolicyDecision {
  policy: Policy;
  path: DecisionPath;
}

export interface PolicyTool {
  policy: Policy | null;
  acknowledgedAt: Date | null;
  /** Set when the tool's definition changed after it was recorded (rug pull);
   * cleared when the user acknowledges it or sets its policy. Required on
   * purpose: forgetting to pass it must not silently allow a changed tool. */
  changedAt: Date | null;
}

/** The tool is new (never acknowledged) or changed: the user has to look at it
 * in the rules. Such a tool is never snoozable. Fails closed: a `changedAt`
 * still set counts as changed even if `acknowledgedAt` is set too. */
export function awaitingReview(tool: PolicyTool | null): boolean {
  return tool === null || !tool.acknowledgedAt || isChanged(tool);
}

function isChanged(tool: PolicyTool): boolean {
  return tool.changedAt !== null && tool.changedAt !== undefined;
}

export interface PolicyInput {
  /** The upstream's default policy. */
  upstreamDefault: Policy;
  /** The KnownTool row for the called/listed name, or null when xitl has never
   * seen the upstream list it (an agent calling it is guessing). */
  tool: PolicyTool | null;
  /** The ClientToolPolicy for (this tool, this MCP client), if any. */
  clientOverride: Policy | null;
  /** The latest live-looking Snooze.until for (this client, this tool), if any. */
  snoozedUntil?: Date | null;
  /** ADR-0026: the latest live DENY pause covering (this client, this tool),
   * if any (approval/snooze.ts; any effect other than ALLOW counts). Fails
   * closed: a value that is not provably expired at `now` denies. */
  denyPausedUntil?: Date | null;
  /** Now (from the Clock); required for a snooze to count. */
  now?: Date;
}

const POLICIES: readonly string[] = ['ALLOW', 'ASK', 'DENY'];

/** Anything that isn't exactly a Policy is DENY (fail closed). */
function sane(value: unknown): Policy {
  return typeof value === 'string' && POLICIES.includes(value) ? (value as Policy) : 'DENY';
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const base = baseDecision(input);
  if (
    base.policy === 'ASK' &&
    !awaitingReview(input.tool) &&
    input.snoozedUntil instanceof Date &&
    input.now instanceof Date &&
    !Number.isNaN(input.snoozedUntil.getTime()) &&
    input.snoozedUntil.getTime() > input.now.getTime()
  ) {
    return { policy: 'ALLOW', path: 'snooze' };
  }
  return base;
}

/** A deny pause is set and not provably over: anything but a valid `until`
 * at or before a valid `now` counts as live (fail closed). */
function denyPauseLive(until: unknown, now: unknown): boolean {
  if (until === null || until === undefined) return false;
  const expired =
    until instanceof Date &&
    now instanceof Date &&
    !Number.isNaN(until.getTime()) &&
    !Number.isNaN(now.getTime()) &&
    until.getTime() <= now.getTime();
  return !expired;
}

function baseDecision(input: PolicyInput): PolicyDecision {
  const { tool } = input;
  if (!tool) return { policy: 'DENY', path: 'unknown-tool' };
  if (denyPauseLive(input.denyPausedUntil, input.now)) return { policy: 'DENY', path: 'snooze-deny' };

  const changed = isChanged(tool);
  // An explicit ALLOW does not cover a definition the user hasn't seen.
  const explicit = (policy: Policy, path: DecisionPath): PolicyDecision =>
    changed && policy === 'ALLOW' ? { policy: 'ASK', path: 'changed-tool' } : { policy, path };

  if (input.clientOverride !== null && input.clientOverride !== undefined) {
    return explicit(sane(input.clientOverride), 'policy:client');
  }
  if (tool.policy !== null && tool.policy !== undefined) {
    return explicit(sane(tool.policy), 'policy:tool');
  }
  if (changed) return { policy: 'ASK', path: 'changed-tool' };
  if (!tool.acknowledgedAt) return { policy: 'ASK', path: 'new-tool' };
  return { policy: sane(input.upstreamDefault), path: 'policy:upstream-default' };
}
