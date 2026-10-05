# Roadmap archive

Shipped roadmap entries, newest first. The reasoning is in `decisions/`, the
test evidence in `testing.md`'s run log.

## 2026-10-05

- **`v0.2.0` released** (Matthias's call): slice 8 + changed-tool rule,
  per-upstream access tokens, MCP sessions with diagnostics. Manual gates
  MG-01…06 still open (deployed instance).
- **MCP sessions (ADR-0016), step 1:** session ids for 2025-era clients, stored
  in the DB, attributed to audit/approvals, Sitzungen view with diagnostics.
  TC-55…60. Built by an Opus agent, reviewed by the lead.

- **Per-upstream access tokens (ADR-0015)** asked for by
  Matthias: a TOKEN-kind client per user + upstream, `Authorization: Bearer
  xitl_…`, shown once, SHA-256 stored, revocable; OAuth paths reject TOKEN
  clients. TC-50…54. Built by a Sonnet agent, gate reviewed by the lead.

## 2026-10-04

- **Milestone 1, slice 8 + changed-tool rule**: a
  changed tool never resolves to allow (Matthias's decision); malicious-client
  suite TC-38…49. Gaps found and fixed: held calls survived revoking their
  client / deleting or re-pointing their upstream (now denied `+revoked`); no
  body limits (now 64 KiB `/api`, 1 MiB `/mcp`/`/oauth`); no cap on held calls
  or approval streams (10 / 5 per user); protected-resource check was
  origin-only (now SDK `checkResourceAllowed`); OAuth discovery followed
  redirects (now refused); our credentials could pass through in upstream tool
  lists/instructions (now scrubbed), unbounded upstream responses (10 MiB MCP,
  1 MiB OAuth, max 500 tools). Built by an Opus agent, reviewed by the lead.

- **`v0.1.0` released** (Matthias's call): slices 1–7 below. Without slice 8
  and without the manual gates MG-01…05, which need the deployed instance.
- **Milestone 1, slices 6–7:** held calls with approval page (live via SSE),
  Web Push with approve/deny actions (copied from Haushalt), snooze (15 min /
  1 h / today; not for new/changed tools), 300 s budget shared by wait and
  upstream call, rug-pull re-flag ("Geändert"), Verlauf (audit list). TC-27…37.
  Built by an Opus agent, reviewed by the lead.

- **Milestone 1, slices 2, 4, 5:** upstream OAuth client (connect flow, state
  bound to user, refresh, reconnect; HEADER/NONE ready without connect), proxy
  core on `/mcp/<slug>` (policy re-evaluated per call, audit row per call,
  `ask` denies until slice 6, secrets scrubbed from results), policy engine and
  the "Regeln" view. TC-15…26. Built by an Opus agent, reviewed by the lead.

- **Milestone 1, slices 1 and 3:** data model (lead), upstream registry
  (`/api/upstreams`, Settings UI) and inbound MCP OAuth copied from Haushalt,
  adapted to `/mcp/<slug>` (stub server, no tools yet). TC-05…14. Built by a
  Sonnet agent, reviewed by the lead.
