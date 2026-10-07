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

## Amendment 2026-10-07: Sperre with a purpose (ADR-0029 machinery)

Decided by Matthias, built in `5b8b9f5`.

- Deny pauses store their anchor (the refused call) and an optional human
  purpose ("Wofür?", same field as the Zeitfreigabe).
- **No purpose: unchanged, Clef is never asked** (Matthias).
- With a purpose and Clef active, each covered call gets one `noul`: "Is the
  new call clearly outside what the human wanted to block? If in doubt: no."
  (state: trusted purpose, refused anchor, new call). Only if p ≥
  `PAUSE_CHECK_THRESHOLD` for **every** covering Sperre does the call fall
  back to **ASK** (`snooze-deny-ki-ask`), never ALLOW; a rule DENY under it
  stays DENY (no request then). Below, error, timeout, garbage, Clef or switch
  off, missing anchor: refused as before; errors raise the shared outage
  notice. The Sperre stays in place either way. `AuditEntry.sperreScore`.
- Held calls covered when a Sperre is set are still refused at once, without
  a check (stricter).
