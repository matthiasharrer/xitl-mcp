# 0041. Start a Zeitfreigabe from Freigaben without a held call

- **Status:** Accepted (Matthias 2026-11-07, request), built 2026-11-07, released in `v0.19.0`
- **Date:** 2026-11-07

## Context

A Zeitfreigabe (ALLOW Snooze, ADR-0026) could only be granted on a held call's
card. Matthias wants to start one ahead of time from the start page, where
„Läuft gerade“ shows the running ones: a button, a dialog, pick an upstream;
"vermutlich reicht zunächst pauschal alle Tools des Upstreams".

Constraints from the model:

- A Snooze belongs to one access (`mcpClientId`, required): Zeitfreigaben
  are per access everywhere else, so the dialog has to name one.
- The KI-Prüfung (ADR-0029) needs an anchor (the held call) and, since the
  2026-11-07 amendment, a purpose. Without a held call there is no anchor.

## Decision

- **Button „+ Zeitfreigabe“** next to the „Freigaben“ heading (always
  visible, also when nothing runs). Dialog: Upstream, Zugang (the accesses
  that reach it: OAuth clients, its tokens, all-upstreams tokens; the first
  one preselected), Dauer 15 Min. / 1 Std. / bis Mitternacht (as on the card).
- **Scope is always the whole upstream** (`UPSTREAM`), effect ALLOW, no
  anchor, no purpose → **no KI-Prüfung** (gate: anchor null → blind). The
  dialog says so: „Gilt für alle Tools des Upstreams, die sonst fragen. Neue
  oder geänderte Tools fragen weiter. Ohne KI-Prüfung.“
- Nothing else changes about the row: it only turns ASK into ALLOW, never for
  new or changed tools, never overrides DENY or a Sperre (policy.ts); it shows in
  „Läuft gerade“ and ends like any other.
- API under `/api` (Authelia identity only, never `/mcp`):
  `GET /api/running/targets`, `POST /api/running/pauses` `{ upstreamId,
  clientId, snoozeMinutes | snoozeUntilMidnight }`. Strict body, exactly
  one duration; a foreign or unknown upstream or access, or an access that
  cannot reach the upstream → 404, nothing written.

## Consequences

- An agent cannot reach this (no MCP tool; `/api` needs `Remote-User` from
  the ingress). It widens nothing an approval card could not already grant.
- Not built (later, if wanted): one tool or „alle Lesetools“, several
  accesses at once, a Sperre ahead of time, a „Wofür?“ with a KI-Prüfung (it
  would need a check without an anchor, i.e. a new Clef prompt shape and a
  bench).
