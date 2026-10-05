# 0019. Calls grouped by day and time gaps; pauses for a tool, read-only tools or an upstream

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

ADR-0016 measured what identifies a chat: Claude.ai and Claude Code both
speak MCP 2026-07-28 (no sessions), and trace ids, `claudecode/toolUseId` and
`progressToken` change on every call. Nothing is stable per chat. Matthias
also wants day separators in Verlauf, and pausing the question for more than
one tool at a time.

## Decision

- **Grouping (UI only, `apps/web/src/lib/grouping.ts`):** Verlauf shows day
  separators (Heute, Gestern, date) in the browser's time zone; within a day,
  calls group per MCP session if the client has one, else per client with a
  gap of at most 10 minutes between consecutive calls. Freigaben groups held
  calls the same way and shows headers only when more than one group exists.
  Nothing is stored for it; it is a view of the audit rows.
- **Pause scopes:** a snooze (ADR-0004) now covers one tool (`TOOL`, as
  before), every **read-only** tool of the upstream (`READONLY`, offered only
  when approving a read-only tool), or every tool of the upstream
  (`UPSTREAM`). Always for one client and one upstream.
- Unchanged guarantees: a snooze only turns ASK into ALLOW, never DENY;
  never for new or changed tools. "Read-only" is the tool's **stored**
  annotations (`readOnlyHint`); an annotation change marks the tool changed,
  so an upstream relabelling a write tool as read-only gets asked again.

## Consequences

- Two chats in parallel on the same connector land in one group. Rare for
  personal use.
- `READONLY` trusts the upstream's own `readOnlyHint` as reviewed when the
  tool was acknowledged; a dishonest upstream that declares a write tool
  read-only from the start is covered. Accepted: the upstream is chosen by the
  user, and the rules page shows the hint per tool.

## Alternatives considered

- **Storing a group id** on audit rows: nothing reliable to store it from.
- **Pause for all upstreams of a client:** not asked for; too wide.
