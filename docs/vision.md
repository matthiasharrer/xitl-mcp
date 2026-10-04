# Vision

_From Matthias's briefing, 2026-10-04 (bootstrap session). This is the "why"
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
2. **Personal, not multi-tenant.** One admin, one reviewer. Simplicity beats
   generality; team features are explicitly out (see `ideas.md`).
3. **Fail closed.** No answer in time means deny, with a structured reason. An
   upstream's default policy can never be `always_allow`.
4. **Config as code, applied by a human.** Policies are YAML files. An LLM may
   *draft* changes; only the human applies them, from the CLI.
5. **Everything is audited.** One complete record per call, including how the
   decision was reached.
6. **Testable by autonomous agents from day one.** Clock, LLM endpoint and push
   sender are injectable; nothing depends on a real human or real time in tests.

## Phases (Matthias's sequencing)

1. Proxy core + policy engine, approval in the browser via SSE.
2. OAuth authorization server: DCR, PKCE, trust tiers.
3. Meta server for LLM-assisted config: discovery first; `apply_draft` CLI-only
   from the start.
4. Web Push to the phone.

## Out of scope for v1

Multi-reviewer / multi-admin, field-level audit redaction, upstream OAuth
(tokens are pasted by the admin), queue/resume for slow approvals,
payload-similarity snooze. All parked in `ideas.md` with their triggers.
