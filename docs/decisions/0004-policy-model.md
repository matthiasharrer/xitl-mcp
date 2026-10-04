# 0004. Policy model: three outcomes, fail closed, auto-deny on timeout

- **Status:** Proposed — from a months-old summary of earlier discussions; Matthias wants to re-discuss before it binds (2026-10-04)
- **Date:** 2026-10-04

## Context

The core of the product: every `tools/call` gets a decision. The agent is
untrusted, the reviewer is one human, and Claude.ai gives up on a tool call
after about **300 s**.

## Decision

- **Outcomes:** `always_allow`, `always_deny`, `require_approval`. Approval goes
  to a human, a reviewer agent, or an agent that escalates (modes in ADR-0006).
- **Inputs:** the tool, its **classification** (`read` / `write`, set
  explicitly in config, never guessed), and the **caller identity** (OAuth
  client and its trust tier, ADR-0007).
- **Upstream `default_policy` can never be `always_allow`.** Config load rejects
  it. Only individual tool entries may loosen.
- **Timeout ⇒ auto-deny** with a structured reason the agent can read ("not
  approved within 300 s"). **No queue/resume** in v1.
  _Matthias, 2026-10-04: auto-deny after 300 s is fine, the agent can retry.
  The timeout behaviour belongs **in the policy**, assignable per upstream and
  overridable per tool, so queue/resume can be added later as another value
  without reshaping config. v1 implements only `auto_deny`._
- **Snooze:** when approving by hand, the reviewer may snooze future prompts for
  *this caller + this tool* with a TTL. A snooze is a rule on the same path as
  permanent policy, and the audit marks it separately ("allowed by snooze").
- Pending calls live in an in-memory map, decoupled from the approval channels
  by an `EventEmitter` (SSE now, push later, reviewer agent in parallel).

## Consequences

- Pending approvals don't survive a restart: they deny, consistent with fail
  closed. Single replica, so nothing else could pick them up anyway.
- Slow reviewers lose calls. If that turns out to be common in practice,
  queue/resume is the parked alternative (`ideas.md`).

## Alternatives considered

- **Async/resume (job id, poll or re-present next turn).** Recommended by the
  earlier timeout document; Matthias's design document chose auto-deny instead,
  and that is the current decision. The contradiction is noted in `roadmap.md`
  until he confirms. **Confirmed 2026-10-04:** auto-deny.
- **Risk tiers inferred from tool names.** Contradicts "check intent, not a
  blocklist" and is guessable by the agent.
