# Roadmap archive

Shipped roadmap entries, newest first. The reasoning is in `decisions/`, the
test evidence in `testing.md`'s run log.

## 2026-10-04

- **Milestone 1, slices 2, 4, 5:** upstream OAuth client (connect flow, state
  bound to user, refresh, reconnect; HEADER/NONE ready without connect), proxy
  core on `/mcp/<slug>` (policy re-evaluated per call, audit row per call,
  `ask` denies until slice 6, secrets scrubbed from results), policy engine and
  the "Regeln" view. TC-15…26. Built by an Opus agent, reviewed by the lead.

- **Milestone 1, slices 1 and 3:** data model (lead), upstream registry
  (`/api/upstreams`, Settings UI) and inbound MCP OAuth copied from Haushalt,
  adapted to `/mcp/<slug>` (stub server, no tools yet). TC-05…14. Built by a
  Sonnet agent, reviewed by the lead.
