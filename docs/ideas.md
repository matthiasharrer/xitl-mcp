# Ideas

> Parking lot for things that are **not scheduled**. An idea moves to
> `roadmap.md` when it's decided and scheduled. Keep entries short and dated.

## From the briefing (2026-10-04): not decided or deliberately deferred

- **Discovery/config UI:** a lean, mostly read-only browser for upstreams and
  policies.
- **Payload-level snooze** ("stop asking about this query shape") via LLM
  similarity. Deferred **until the reviewer side has injection protection**.
- **Queue/resume** as the async approval model (job id, polling or re-present
  next turn). The alternative to auto-deny if slow reviewers turn out to be
  common (ADR-0004).
- **Per-platform defaults:** Claude.ai's hard 300 s limit vs Claude Code's
  configurable timeout.
- **Timeout policy per rule** (auto-deny, retry or queue), e.g. different for
  destructive vs read-only.
- **MCP elicitation** as the protocol hook for "waiting on a human". Doesn't
  solve the 300 s problem, but expresses it cleanly.
- **Progress notifications** mirrored to a push channel, not only the client
  dialog.
- **Multi-reviewer escalation and multi-admin** with a real user store. Out for
  personal use; the path to a team version.
- **Field-level audit redaction/encryption.** Becomes relevant with a second
  reviewer, weaker disk guarantees, or an upstream returning secrets-manager
  output (ADR-0008).
- **Upstream OAuth:** a second OAuth-client subsystem with token refresh. In v1
  the admin pastes tokens.
- **Multiple push subscriptions per reviewer** (phone + desktop) for redundancy.
- **Other delivery channels:** Pushover, FCM/APNs, Slack/Teams.
- **Prior art to borrow from:** YAML rules with named approvers
  (microsoft/agent-governance-toolkit), integrity levels (gh-aw-mcpg),
  prompt-injection guardrails (enkrypt), hash-chained audit (SidClaw).
