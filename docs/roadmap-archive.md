# Roadmap archive

Shipped roadmap entries, newest first. The reasoning is in `decisions/`, the
test evidence in `testing.md`'s run log.

## 2026-10-05

- **`v0.4.1` released** (Matthias's call): the security fixes below.
- **Security fixes:** a URL change of an upstream
  marks every tool changed (explicit ALLOWs ask until reviewed, policies
  kept), deletes its snoozes and needs a HEADER secret again (ADR-0021);
  never-approved DCR clients expire after 24 h, at most 100 exist; KnownTool
  rows capped at 1000 per upstream (stale ones pruned first). TC-85…89.
- **`v0.4.0` released** (Matthias's call): outbound address policy with
  per-upstream confirmation (ADR-0020); header title links to Freigaben.
- **Header title → Freigaben:** "xitl" in the app bar is a link to `#/`.
- **Outbound address policy (ADR-0020):** all upstream, OAuth and push
  requests go through `lib/outbound.ts`; internal addresses (checked at
  connect time, DNS-rebinding-safe) are refused unless listed in
  `OUTBOUND_ALLOW_PRIVATE`; German 400 when saving such an upstream URL or push
  endpoint. Closes the two SSRF debt items (upstream URL, discovery).
  TC-77…81 + unit. Then (Matthias's decision) the exception moved to the
  upstream itself: an internal URL needs "Trotzdem erlauben" in the form
  (`Upstream.allowInternal`, only for that URL's host:port, recomputed on
  URL change, "intern" chip); the env list stays as an optional admin
  override. No deploy config needed. TC-82…84. Unreleased.
- **Deployed; manual gates MG-01…04 and MG-06 passed** (run log #12).
- **`v0.3.3` released** (Matthias's call): grouping by day and time gaps,
  pause scopes (ADR-0019).
- **Grouping + pause scopes (ADR-0019):** Verlauf day separators and groups
  per session/client by 10-min gaps, Freigaben groups; pauses for one tool,
  all read-only tools or all tools of an upstream. TC-75/76 (Sonnet agent).
- **`v0.3.2` released** (Matthias's call): trace ids and `x-anthropic-client`
  per call (grouping candidates), version footer in Einstellungen. Verified
  live before tagging: Claude Code (own client, all-upstreams token) called
  `haushalt-todos_list_tasks` on `/mcp` successfully.
- **`v0.3.1` released** (Matthias's call): sessions for chunked `initialize`
  (bug: no sessions behind the HTTP/2 ingress), per-call diagnostics on every
  audit row. TC-73/74. Next measurement: MG-06 with "Diagnose" per call.
- **`v0.3.0` released** (Matthias's call): unified `/mcp` + token scope.
- **Token scope (ADR-0018):** access tokens for one or all upstreams; every
  endpoint takes OAuth and tokens ("all kinds of auth for all kinds of
  downstream", Matthias). TC-69…72. Built by the lead, spec by a Sonnet agent.
- **Unified `/mcp` endpoint (ADR-0014, ADR-0017):** all of a user's upstreams
  in one connector, `<slug>_` names (first `_` splits, collision-free), OAuth
  only, degrade per upstream, generated instructions, sessions without
  upstream, "Alle Upstreams" card in Einstellungen. TC-61…68. Built by the
  lead (security path), spec written and run by a Sonnet agent. Unreleased.
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
