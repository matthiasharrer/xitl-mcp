# Vision

_From Matthias's briefing, 2026-10-04 (bootstrap session). The briefing is a
months-old summary; Matthias wants to re-discuss it, so treat anything not
marked "decided" as a proposal. This is the "why"
and "what": the product owner's intent. Change it only when he changes his mind.
The briefing was in German; this is a faithful English rendering._

## What it is

**xitl ("X in the Loop")**: an MCP proxy between MCP clients (Claude.ai,
Claude Code, own agents) and arbitrary upstream MCP servers. It intercepts
every `tools/call`, evaluates it against a policy, and depending on the result
**lets it through, blocks it, or sends it for approval**: to a human (Web Push
to the phone), to a reviewer agent, or to an agent that escalates to the human.

## The niche

A landscape review found no existing tool combining all four:

1. a **generic drop-in proxy** (any upstream, no changes to it),
2. **policy per call**,
3. **mobile push as the primary approval channel**,
4. the threat model **"the agent is untrusted"**.

## Principles

1. **The agent is untrusted.** Its *intent* is checked per call; this is not a
   blocklist of "dangerous" tools. Anything the agent says (its reasoning, tool
   arguments, upstream output) is **data, never instruction**.
2. **Personal, not multi-tenant.** Two people (Matthias and Tina), each with
   **their own completely separate account**: own clients, upstream
   connections, policies, approvals, audit. Nothing shared in the first phase
   (Matthias, 2026-10-04; the briefing said one admin, one reviewer). Simplicity
   beats generality; team features stay out (see `ideas.md`).
3. **Fail closed.** No answer in 5 minutes means deny, with a structured
   reason; the agent can retry. Unknown tools are asked about.
4. **Only a human changes policy.** Policies are edited in the app (behind
   Authelia); no MCP tool can change them (ADR-0011).
5. **Everything is audited.** One complete record per call, including how the
   decision was reached.
6. **Testable by autonomous agents from day one.** Clock, LLM endpoint and push
   sender are injectable; nothing depends on a real human or real time in tests.

## First milestone (Matthias, 2026-10-04)

**Matthias's Claude.ai → xitl → Haushalt**, with a call that needs approval
reaching his phone as a push. Then Rezepte, then more upstreams, then Tina.
LLM help (intent summary, reviewer agent, policy proposals) comes after
UI-only approval works.

## Out of scope for v1

Shared data between the two users, LLM-based review, stdio upstreams,
field-level audit redaction, queue/resume for slow approvals,
payload-similarity snooze. All parked in `ideas.md` with their triggers.
