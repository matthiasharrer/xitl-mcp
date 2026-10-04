// The policy engine (ADR-0004): ONE pure function that decides what happens to
// a tools/call (and whether/how a tool is listed). No DB, no clock, no I/O: the
// caller loads the rows and passes them in, so every precedence rule is
// unit-tested (policy.test.ts, TC-24).
//
// Precedence, first match wins:
//   1. tool unknown (not in KnownTool)      -> DENY  "unknown-tool"
//   2. per-client override                  -> it    "policy:client"
//   3. per-tool policy                      -> it    "policy:tool"
//   4. tool not yet acknowledged (new)      -> ASK   "new-tool"
//   5. the upstream's default               -> it    "policy:upstream-default"
//
// Fail closed: anything that is not a recognised Policy value is treated as
// DENY (a corrupted row must never become ALLOW).

export type Policy = 'ALLOW' | 'ASK' | 'DENY';

export type DecisionPath =
  | 'unknown-tool'
  | 'policy:client'
  | 'policy:tool'
  | 'new-tool'
  | 'policy:upstream-default';

export interface PolicyDecision {
  policy: Policy;
  path: DecisionPath;
}

export interface PolicyInput {
  /** The upstream's default policy. */
  upstreamDefault: Policy;
  /** The KnownTool row for the called/listed name, or null when xitl has never
   * seen the upstream list it (an agent calling it is guessing). */
  tool: { policy: Policy | null; acknowledgedAt: Date | null } | null;
  /** The ClientToolPolicy for (this tool, this MCP client), if any. */
  clientOverride: Policy | null;
}

const POLICIES: readonly string[] = ['ALLOW', 'ASK', 'DENY'];

/** Anything that isn't exactly a Policy is DENY (fail closed). */
function sane(value: unknown): Policy {
  return typeof value === 'string' && POLICIES.includes(value) ? (value as Policy) : 'DENY';
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { tool } = input;
  if (!tool) return { policy: 'DENY', path: 'unknown-tool' };

  if (input.clientOverride !== null && input.clientOverride !== undefined) {
    return { policy: sane(input.clientOverride), path: 'policy:client' };
  }
  if (tool.policy !== null && tool.policy !== undefined) {
    return { policy: sane(tool.policy), path: 'policy:tool' };
  }
  if (!tool.acknowledgedAt) return { policy: 'ASK', path: 'new-tool' };
  return { policy: sane(input.upstreamDefault), path: 'policy:upstream-default' };

  // SNOOZE SEAM (slice 6, ADR-0004): a live snooze for (client, tool) turns an
  // ASK decision into ALLOW with path "snooze". It goes here as a post-step on
  // the result above (input gains `snoozedUntil: Date | null` and `now: Date`),
  // and only ever upgrades ASK - never DENY, never an unknown tool.
}
