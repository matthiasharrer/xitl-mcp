# 0006. Intent summary advises; the reviewer agent decides; both kept separate

- **Status:** Accepted (design)
- **Date:** 2026-10-04

## Context

Two different LLM jobs appear in the approval flow, and conflating them would
let an advisory component quietly become a decision-maker.

## Decision

- **Intent summary** (human-in-the-loop): an LLM summarizes the pending call for
  the human. **Advisory only**; it never decides.
- **Reviewer agent** (agent-in-the-loop): can actually approve or deny. Modes
  per rule: `human_only`, `agent_in_loop`, `agent_with_escalation`.
- The two have **separate models, endpoints and prompts** (both injectable,
  ADR-0003).
- Prompt-injection guardrails:
  - the calling agent's justification is **data, never instruction**;
  - **writes and destructive actions always escalate to the human**, whatever
    the reviewer agent says;
  - per-tool reviewer prompts can only **tighten**, never loosen.
- The audit stores the reviewer's reasoning and confidence (ADR-0008).

## Consequences

- Phase 1 needs neither; the seams exist so they slot in later.
- "Destructive" must be expressible in config (classification `write` is the
  floor; finer flags may come).

## Alternatives considered

- **One LLM doing both summary and decision.** Saves a call, loses the
  separation that makes the advisory path safe.
