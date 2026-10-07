// The policy engine (ADR-0004): ONE pure function that decides what happens to
// a tools/call (and whether/how a tool is listed). No DB, no clock, no I/O: the
// caller loads the rows and passes them in, so every precedence rule is
// unit-tested (policy.test.ts, TC-24, TC-184).
//
// Precedence, first match wins (ADR-0032 table):
//   1. tool unknown (not in KnownTool)      -> DENY  "unknown-tool"
//   2. the client's default for this upstream is DENY (ADR-0032), or any
//      value that isn't a recognised Policy -> DENY "client-hidden"
//      The upstream is hidden from this client: beats everything below
//      (deny and allow pauses, client and tool rules, new and changed tools).
//      The client's own tool rules are masked, not reset.
//   3. a live DENY pause covers the call    -> DENY  "snooze-deny" (ADR-0026)
//      (for this client + upstream + tool, matched in approval/snooze.ts).
//      Beats everything below: client/tool ALLOW, the upstream default, an
//      allow pause, new and changed tools. It only ever tightens.
//   4. per-client tool override             -> it    "policy:client"
//   5. per-tool policy                      -> it    "policy:tool"
//      ...except that a CHANGED tool (its definition changed after xitl first
//      recorded it, `changedAt` set; rug pull, TC-36) never resolves to ALLOW:
//      an explicit ALLOW at 4. or 5. becomes ASK "changed-tool" (Matthias,
//      2026-10-04). An explicit ASK or DENY applies unchanged.
//      AUTO (ADR-0030) is resolved at the same steps as ALLOW / ASK / DENY,
//      but like ALLOW it never covers a definition nobody has looked at: an
//      explicit AUTO at 4. or 5. on a CHANGED tool is ASK "changed-tool", on
//      a NEW (unacknowledged) tool ASK "new-tool" (a new or changed tool
//      never reaches the Clef check; rug pull stays ASK).
//   6. tool changed (see above), no rule    -> ASK   "changed-tool"
//   7. tool not yet acknowledged (new)      -> ASK   "new-tool"
//   8. the client's default for this upstream (ALLOW / ASK / AUTO, ADR-0032)
//                                           -> it    "policy:client-upstream"
//      (new and changed tools never get here: 6. and 7. come first)
//   9. the upstream's default               -> it    "policy:upstream-default"
// Then one post-step (ADR-0004 allow snooze, TC-30):
//  10. result is ASK or AUTO, the tool is NOT awaiting review (new or changed, see
//      `awaitingReview`), and a snooze for (this client, this tool) is live
//      at `now`                             -> ALLOW "snooze"
//   An allow snooze only ever upgrades ASK. Never DENY (so never
//   "client-hidden"), never an unknown tool, and never a new or changed tool,
//   whatever path said ASK: those must be looked at in the rules first, so a
//   snooze set before a tool changed under us cannot carry over.
//
// An AUTO result is NOT a decision to forward: the caller (mcp/server.ts,
// auto/gate.ts `resolveAuto`) turns it into ALLOW "auto" only when Clef
// clearly says the user's rule covers the call, and into ASK otherwise
// (below the threshold, error, Clef off, no rule). A live allow pause wins
// over the AUTO check (step 10, then the ADR-0029 check); a deny pause (3.)
// and a hidden upstream (2.) win over everything.
//
// Fail closed: anything that is not a recognised Policy value (ALLOW, ASK,
// DENY, AUTO; e.g. "AUTOO") is treated as DENY (a corrupted row must never
// become ALLOW); in the client's upstream default that means hidden.

export type Policy = 'ALLOW' | 'ASK' | 'DENY' | 'AUTO';

export type DecisionPath =
  | 'unknown-tool'
  | 'policy:client'
  | 'policy:tool'
  | 'client-hidden'
  | 'policy:client-upstream'
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
  /** ADR-0032: the ClientUpstreamPolicy for (this MCP client, this upstream),
   * null when there is none ("Voreinst."). Required on purpose, like
   * `changedAt`: forgetting it must not quietly fall back. DENY (or anything
   * unrecognised) hides the upstream from the client. */
  clientUpstream: Policy | null;
  /** The latest live-looking Snooze.until for (this client, this tool), if any. */
  snoozedUntil?: Date | null;
  /** ADR-0026: the latest live DENY pause covering (this client, this tool),
   * if any (approval/snooze.ts; any effect other than ALLOW counts). Fails
   * closed: a value that is not provably expired at `now` denies. */
  denyPausedUntil?: Date | null;
  /** Now (from the Clock); required for a snooze to count. */
  now?: Date;
}

const POLICIES: readonly string[] = ['ALLOW', 'ASK', 'DENY', 'AUTO'];

/** Anything that isn't exactly a Policy is DENY (fail closed). */
function sane(value: unknown): Policy {
  return typeof value === 'string' && POLICIES.includes(value) ? (value as Policy) : 'DENY';
}

/** ADR-0032: this client's default hides the upstream (DENY, or anything
 * unrecognised: fail closed). null/undefined = no row = not hidden. The one
 * test used by the policy (step 2) and by the proxy's listing and
 * instructions (mcp/server.ts), so they can't disagree. */
export function hidesUpstream(clientUpstream: Policy | null | undefined): boolean {
  return clientUpstream !== null && clientUpstream !== undefined && sane(clientUpstream) === 'DENY';
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const base = baseDecision(input);
  if (
    (base.policy === 'ASK' || base.policy === 'AUTO') &&
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
  // ADR-0032: hidden from this client. `sane` makes garbage DENY (hidden).
  if (hidesUpstream(input.clientUpstream)) {
    return { policy: 'DENY', path: 'client-hidden' };
  }
  if (denyPauseLive(input.denyPausedUntil, input.now)) return { policy: 'DENY', path: 'snooze-deny' };

  const changed = isChanged(tool);
  const unacknowledged = !tool.acknowledgedAt;
  // An explicit ALLOW (or AUTO) does not cover a definition the user hasn't
  // seen; AUTO on a new tool doesn't either (ADR-0030 §3).
  const explicit = (policy: Policy, path: DecisionPath): PolicyDecision => {
    if (changed && (policy === 'ALLOW' || policy === 'AUTO')) return { policy: 'ASK', path: 'changed-tool' };
    if (unacknowledged && policy === 'AUTO') return { policy: 'ASK', path: 'new-tool' };
    return { policy, path };
  };

  if (input.clientOverride !== null && input.clientOverride !== undefined) {
    return explicit(sane(input.clientOverride), 'policy:client');
  }
  if (tool.policy !== null && tool.policy !== undefined) {
    return explicit(sane(tool.policy), 'policy:tool');
  }
  if (changed) return { policy: 'ASK', path: 'changed-tool' };
  if (unacknowledged) return { policy: 'ASK', path: 'new-tool' };
  // ADR-0032: ALLOW / ASK / AUTO replace the upstream default for this
  // client (DENY returned above, so this is never DENY).
  if (input.clientUpstream !== null && input.clientUpstream !== undefined) {
    return { policy: sane(input.clientUpstream), path: 'policy:client-upstream' };
  }
  return { policy: sane(input.upstreamDefault), path: 'policy:upstream-default' };
}
