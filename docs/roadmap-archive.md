# Roadmap archive

Shipped roadmap entries, newest first. The reasoning is in `decisions/`, the
test evidence in `testing.md`'s run log.

## 2026-10-08 (unreleased)

- **„Neue Version verfügbar“ banner (ADR-0035).** An app left open in the
  background kept the old bundle for days (seen in Haushalt; xitl is the same
  stack). When the page returns to the foreground it compares the hashed entry
  script of a fresh `index.html` with its own and offers „Neu laden“. No
  auto-reload, no backend change. TC-212…216.

## 2026-10-07 (`v0.13.1`)

- **Fix:** a tap on the tab bar toggled a switch scrolled under it (Matthias
  paused an upstream by tapping "Freigaben"). TC-211.

## 2026-10-07 (`v0.13.0`)

- **Einstellungen rework** (Matthias picked it from mock screenshots).
  Upstream rows: an "Aktiv" switch (pause), the name, a badge only for a
  problem and one button only for its fix. The upstream's own page
  (`#/regeln/<id>`) has everything general on top (switch, fix, MCP address,
  Neu verbinden, Token, Bearbeiten, Löschen), the rules right below.
  Clients the same way: switch in the list, `#/client/<id>` for the rest.
  "Alle Upstreams" is one compact card. TC-207…210.

## 2026-10-07 (`v0.12.0`)

- **ADR-0032: a default per client and upstream.** Voreinst. / Erlauben /
  Auto / Fragen / Verbieten per (client, upstream); Verbieten hides the
  upstream from that client (no tools, no instructions section, calls get
  the unknown-tool text, held calls refused), masking its tool rules. Regeln
  has a "Gilt für <client>" view with the effective policy and source per tool;
  the client page shows "Sieht / Verborgen". TC-184…193.
- **TC-128 e2e** (held calls settled by a new pause).
- **ADR-0033: pause an upstream.** Hidden from every client, never
  contacted (withUpstream refuses a paused row as the backstop; connect and
  refresh answer 409), calls get the unknown-tool text, held calls refused;
  Einstellungen/Regeln toggle and "Läuft gerade". TC-194…200.
- **ADR-0034: tool freshness on call.** A call re-lists an upstream whose
  tools are older than 5 min (single-flight), a failed re-list refuses
  (`stale-tools`), a tool missing from the latest list is unknown; Regeln
  re-reads on a `tools` event. TC-201…206.

## 2026-10-07 (`v0.11.0`)

- **"Wofür?" suggestion chips** from the intent model (ADR-0029 amendment),
  only for Zeitfreigaben.
- **"Läuft gerade"**: overview of all Zeitfreigaben, Sperren and paused
  accesses on the Freigaben page.

## 2026-10-07 (`v0.10.0`)

- **Clef experiments → three features.** Clef-Flash and Clef 27B benchmarked
  (pause check, tool risk, injection, prose policy; `scripts/bench/clef_*.py`,
  numbers in ADR-0029/0030 and ideas.md). Built: **Zeitfreigabe AI check**
  (ADR-0029, no count cap per Matthias, a mismatch ends all Zeitfreigaben of
  the access on the upstream), **tool review hint + inputSchema change
  detection** (ADR-0031), **AUTO policy with a prose rule** (ADR-0030),
  **"Wofür?" purpose** for Zeitfreigabe and Sperre (amendments 0029/0026).
  All optional: without `PAUSE_CHECK_URL` nothing changes.
- **Verlauf live** (ADR-0028).
- **Wording:** "Pause" → "Zeitfreigabe" (allow) / "Sperre" (deny);
  "pausiert" only for a blocked access.

## 2026-10-06

- **Client cancel ends a held call (TC-132, Matthias):** Claude.ai's
  "Abbrechen" left the approval card standing until the timeout; xitl now
  honours MCP `notifications/cancelled` (matched by client, session,
  endpoint and JSON-RPC id; ambiguous → no-op). Not yet confirmed that
  Claude.ai sends it (check the next cancelled call's audit: `+aborted`).
- **xitl refuses itself as an upstream (ADR-0027).**

## 2026-10-05

- **`v0.5.0` released** (Matthias's call): pause an access, session expiry,
  static `OPTIONS` fix, resolved push for revoked/paused calls.
- **Pause an access (ADR-0024, Matthias):** every MCP client (token or OAuth)
  can be paused and resumed in Einstellungen; the gate answers 403
  `access_paused` (not 401, no re-auth), held calls end `+paused`, rules,
  snoozes and the OAuth grant are kept. TC-102…105.
- **Housekeeping:** MCP sessions expire after 30 days unseen, ≤ 500 per user
  (ADR-0016 amendment, TC-100); `OPTIONS` on static paths answers 204 instead
  of hanging (TC-101); revoked/paused held calls replace their stale
  notification (TC-104).
- **`v0.4.2` released** (Matthias's call): fault push + Freigaben card
  (ADR-0022), browser origins per token (ADR-0023).
- **Browser origins per token (ADR-0023, Matthias: llama.cpp web UI):**
  access tokens list allowed web origins (at creation or later); CORS on
  `/mcp*` only, preflight + per-token check, OAuth unchanged. TC-96…99.
- **Failing upstream told to the user (ADR-0022):** `Upstream.lastFailureAt`
  set/cleared by `withUpstream`; on a transition into unreachable/reconnect a
  push (max. 1 per upstream per hour) and a live "Störung" card on Freigaben;
  `/mcp` instructions carry a state line per upstream; Einstellungen shows
  "Nicht erreichbar" + "Erneut prüfen". A `xitl-status` placeholder tool was
  built first and dropped at Matthias's request. TC-90…95.
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
