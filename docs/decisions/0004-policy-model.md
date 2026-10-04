# 0004. Policy model: allow, deny or ask; auto-deny on timeout

- **Status:** Accepted (revised with Matthias, 2026-10-04; the briefing version
  is in git history)
- **Date:** 2026-10-04

## Context

Every `tools/call` gets a decision. The calling agent is untrusted; the
reviewer is the user who owns the call (ADR-0010). Claude.ai gives up on a
tool call after about **300 s**.

## Decision

- **Outcomes:** `allow`, `deny`, `ask` (ask = a human approves; a reviewer agent
  is deferred, ADR-0006).
- **Per user, per upstream default**, overridable **per tool**, optionally
  **per client** (e.g. stricter for one agent). Any default is allowed,
  including `allow`: Matthias wants Haushalt and Rezepte allowed by default.
  _(Briefing said a default may never be `allow`; dropped.)_
- **Read/write classification** comes from the upstream's MCP tool annotations
  (`readOnlyHint`, `destructiveHint`) and can be overridden per tool. It's shown
  in the UI to help choose a policy; it does not decide by itself.
- **A tool not seen before** (the upstream added it later) is `ask` until the
  user has set a policy for it, whatever the upstream default says, and the
  user is told about it. Cheap protection against an upstream changing under us.
- **Timeout:** 5 minutes, then **deny** with a structured reason the agent can
  read ("nicht innerhalb von 5 Minuten freigegeben, später erneut versuchen").
  The agent can retry. The timeout action is a field on the policy so queue or
  resume can be added later; v1 knows only `deny` with a fixed 300 s.
- **Snooze:** when approving, the user may allow *this client + this tool* for a
  while (TTL). Same rule path as permanent policy; the audit says "via snooze".
- **No trust tiers.** The per-client override covers the same need for a
  handful of clients.
- Pending calls live in memory, decoupled from channels (push, approval page)
  by an `EventEmitter`. A restart drops them: they deny (fail closed).
- The decision is **one pure function** (call, policy, snoozes, clock →
  decision + decision path), unit-tested with Vitest fake timers.

## Consequences

- Slow approvals lose the call; the agent retries. Queue/resume stays in
  `ideas.md` until that hurts.
- "Allowed by default" upstreams still get every call audited (ADR-0008).

## Alternatives considered

- **Async/resume.** Matthias: auto-deny is fine for now, an agent can retry.
- **Default never `allow` (briefing).** Too strict for low-stakes upstreams;
  the new-tool rule keeps the safety that mattered.
