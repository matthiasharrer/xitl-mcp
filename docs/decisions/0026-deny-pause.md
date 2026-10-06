# 0026. "Ablehnen und nicht mehr fragen": a deny pause per tool or upstream

- **Status:** Accepted (2026-10-06, Matthias)
- **Date:** 2026-10-06

## Context

The allow pause (ADR-0004 snooze, scopes per ADR-0019) turns ASK into ALLOW
for a while. Testing ADR-0025, Matthias let an agent archive every task: he
had to deny each call by hand while the agent kept going. He asked for the
opposite: "forbid this for 15 minutes and stop asking".

## Decision

- A snooze gets an **effect**: `ALLOW` (today's, default) or `DENY`.
- A deny pause is created from the app only (card + detail page), as
  "Ablehnen und nicht mehr fragen bei …" with scope **this tool** or **the
  whole upstream**, and the same durations as the allow pause (15 min, 1 h,
  today). It denies the held call it was created from. Push keeps two
  buttons (Erlauben/Ablehnen).
- **Policy precedence:** a live deny pause matching (client, upstream, tool)
  → `DENY`, path `snooze-deny`, **before everything except unknown-tool**:
  it beats explicit ALLOW (tool or client rule), the upstream default and a
  live allow pause. It applies to new and changed tools too (it only ever
  tightens). Unknown tools stay `unknown-tool` (DENY anyway).
- The agent gets a German error saying the user blocked this tool (or the
  upstream) until <time>, so it stops retrying.
- Active pauses of both effects become visible: Regeln of the upstream lists
  them (scope, effect, until, client) with "Aufheben". Lifting is the only
  edit; nothing else changes a pause.
- Audit: the denied calls are DENIED with `snooze-deny`, summarized like any
  call (ADR-0025).

## Consequences

- `policy.ts` gains one input and one early rule; unit tests cover the
  precedence table.
- Wide deny (whole upstream) can lock out a legitimate agent for up to the
  rest of the day; "Aufheben" in Regeln is the way back.
- Tools stay listed in `tools/list` while denied (no `list_changed`; the
  error explains).

## Alternatives considered

- **A third push button.** Android shows few actions, iPhone none, and no
  scope/duration choice there. Not now.
- **Setting the tool's rule to DENY.** Permanent; the user wanted temporary.
