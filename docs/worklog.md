# Worklog

> One short entry **per working session**, newest first: where we left off, why,
> dead-ends, gotchas. Git covers the fine-grained "what".

## 2026-10-07 — Live Verlauf (ADR-0028)

- Matthias: push updates on Verlauf too. New `history` event on the existing
  `/api/approvals/stream` carrying one list row (`serializeAuditRow`, shared
  with `GET /api/audit`); source `lib/auditEvents.ts`, emitted at the AuditEntry
  writes in `mcp/server.ts` and `intent/store.ts`; the stream re-reads the row
  with the user in the query. Verlauf merges via `lib/historyLive.ts`, refetches
  on every `snapshot` (reconnect heal); HistoryDetail refetches on its id.
  TC-133…136, suite green (unit 411, e2e 154).
- **Gotcha:** `page.context().setOffline()` does not close an open EventSource;
  TC-135 simulates reconnects by fulfilling the stream route with a finite body.
- Not live (documented in the ADR): FK `SetNull` on revoke/upstream delete, boot sweep.

## 2026-10-07 — Clef-Flash benchmark prepared, not run

- Matthias deployed Clef-Flash as its own service `llama-cpp-clef` (ns `ai`).
  From the workspace it resolves but TCP times out, even after his
  NetworkPolicy update; he is restarting the workspace. Resume steps are in
  the status note of roadmap item 0.
- Wrote `scripts/bench/clef_bench.py` (14 cases, de/en). It has not run yet.
- **Gotcha:** `/v1/systemone` questions use `instructions`, not `question`.
  The qwen server (b11429) has the endpoint but answers 501 there.

## 2026-10-06 (evening) — Self-loop guard, Clef research

- Matthias saw no registration in Rezepte for his second Rezepte upstream:
  he had entered xitl's own `/mcp/rezepte` as its URL (xitl rezepte-arbeit ->
  xitl rezepte -> rezepte). Local repro with both apps (throwaway rezepte on
  :3100 with a DB copy, since dev rezepte runs without `MCP_TOKEN`) showed
  both OAuth directions working, which ruled out a real registration bug.
  Built ADR-0027 (save-time `own_address` + per-process `X-Xitl-Instance`
  loop guard, 508), TC-130…131; full suite green.
- **Gotcha:** TC-128/129 were already taken (late session); check the highest
  TC in testing.md, not the worklog, before numbering.
- **Gotcha:** `pkill -f "<pattern>"` inside a Bash call matches the calling
  shell itself (exit 144); kill by PID.
- Discussed "Pause mit KI-Prüfung" and Cloudflare Clef-flash (ideas.md).
- Cancel fix (TC-132): Claude.ai's "Abbrechen" left held calls standing;
  the stateless SDK handler can't route `notifications/cancelled`, so
  mount.ts matches it to the held call (client, session, endpoint, JSON-RPC
  id). Unconfirmed that Claude.ai sends it: check the next cancelled call's
  audit for `+aborted`. Released `v0.9.0` (Matthias: "fix fertig, dann
  release"). llama.cpp PR #29831 (Clef, `/v1/systemone`) merged 2026-10-03.
- Rezepte `v1.41.1` (lead): ADR references removed from MCP tool
  descriptions (Matthias saw "(ADR-0020)" in xitl's tool view).
- Decided, not built: per-client default per upstream (roadmap "To
  prioritize"). Next session starts with the Clef experiment (roadmap item 0);
  Matthias restarts the workspace first, so this chat is gone.

## 2026-10-06 (late) — A pause settles the covered held calls

- Matthias tested xitl from his work agent platform: ~20 held `get_recipe`
  calls, "15 min erlauben" on one left the others waiting. Now a pause (allow
  or deny) also decides the held calls it covers (TC-128; lead built it
  directly, small). Unit + full suite green; TC-128 e2e still to write.
  Notifications of decided calls are now closed instead of replaced with
  an outcome (TC-129). Released `v0.8.0` at Matthias's request (image
  verified in GHCR). Matthias clears the context next; everything open is in
  roadmap.md "Next". Sibling repos: CI schema-check fix pushed in rezepte
  (`aeaf08c`, CI result not visible: private repo) and haushalts-todos
  (`ff8448c`, green).

## 2026-10-06 (later) — Intent v2, AI titles, deny pause, `v0.7.0`

- Matthias's first real test on `v0.6.0` (create 3 tasks, then archive all,
  denied): summaries invented motives, repeated themselves, never named
  objects. Lead benchmarked prompt/thinking/results variants against the real
  Qwen (ADR-0025 amendment table). Matthias: thinking budget 128 (≤ 5 s ok),
  results in the context ("the upstream is what we protect"), archiving stays
  write, flag the change of direction instead. Plus a 3–5 word AI title as
  headline, and "Ablehnen und nicht mehr fragen" (ADR-0026). He also found
  all-upstreams tokens missing in "Pro Client" (TC-127).
- One Opus agent built all of it. Lead reviewed policy.ts, snooze.ts, the
  server deny path and the approval route line by line; fixed the title
  examples (copied verbatim by Qwen).
- **Gotcha (lead):** `git commit -am` for docs while the agent was still
  working swept its code into six "docs" commits; caught before push,
  soft-reset and re-committed. Commit docs by path while an agent runs.
- New finding (Matthias): Claude.ai web sends one trace id per user message
  (ADR-0016 measurement); generic chat/turn correlation is in ideas.md.
- Released `v0.7.0` at Matthias's request (asked to release once done).
- **The `v0.7.0` tag build failed** at "Schema matches migrations": run from
  the repo root without prisma.config.ts, Prisma 7.10's `migrate diff` prints
  nothing and exits 0 even for a missing migration, and sometimes crashes
  ("Error in Schema engine:"). The check never checked. Fixed (`a96551e`,
  npm script in apps/api, exit 2 fails, tool errors retried); same fix in
  rezepte/haushalts-todos (`db:schema:check`; rezepte already has a
  `db:migrate:check` for data safety). No release (Matthias); `v0.7.0` still
  needs its failed run re-run to get an image.

## 2026-10-06 — Intent summary from the local Qwen (ADR-0025)

- Matthias asked for an LLM-generated intent per call (local Qwen 3.6 via
  llama.cpp, endpoint from rezepte), with session context and KV-cache reuse;
  push raw first, summary later. Lead measured the endpoint (cache works:
  prompt_n 1764 → 37 with an identical prefix) and an injection that made the
  model rate a write as "lesend" → risk floor from tool annotations.
- Matthias decided: all calls, silent replacement push, no tool results,
  thinking off. One Opus agent built it; lead reviewed server.ts, hub, store
  scoping, prompt encoding, sw.js; found and fixed a SW race (update after a
  lock-screen decision turned "Erlaubt" back into a request).
- Matthias added a llama.cpp alias `qwen` (live: `/v1/models` aliases
  `qwen`, `qwen3.6:35b-a3b`); always use the alias. Default
  `INTENT_LLM_MODEL=qwen`; llama.cpp echoes the requested alias as `model`,
  so `intentModel` says `qwen`, not the version.
- GitOps env + NetworkPolicy done by Matthias's agent ahead of the release.
  Released `v0.6.0` at Matthias's request.
- Open: MG-08 on the deployed app (incl. whether a dropped update push makes
  Android show Chrome's generic "updated in the background" notification);
  system prompt tends to repeat itself between intent and "Auffällig".

## 2026-10-05 — Pause an access; housekeeping

- Matthias asked for the housekeeping (sessions TTL, static OPTIONS) plus
  pausing an access, and a release at the end (`v0.5.0`). The lead wrote
  ADR-0024, the ADR-0016 amendment and TC-100…105; one Opus agent built all
  slices; lead reviewed gate, PATCH, re-check after approval and static.ts
  line by line, re-ran gates (unit 289, e2e 124) + mutation on the pause check.
- Decisions: 403 `access_paused` (401 would start re-auth on Claude.ai);
  pause check after the origin check, so CORS only for an allowed origin;
  OAuth refresh still mints while paused (grant kept). Sessions: 30 days,
  500 per user, no timer.
- Gotcha: `serveStatic` treats OPTIONS like HEAD (200 + Content-Length, no
  body), which is why clients hung. A `false &&` mutation breaks the build
  (TS); use a type-safe one.

## 2026-10-05 — Fault push + Freigaben card; browser origins per token

- `v0.4.2` released and deployed; Matthias confirmed the llama.cpp web UI works
  in the browser via `/mcp` (Qwen 3.6, 41 tools). Fault push not yet seen live.
- Matthias dropped the `xitl-status` placeholder ("remove that extra tool")
  for push + an entry in the Freigaben work list; ADR-0022 revised in place
  (unreleased). He then asked for CORS for the llama.cpp web UI, per token
  (ADR-0023). He pushed back on "breaks my daily connector" (the project is
  a day old); the reason for leaving OAuth clients alone stands: Claude.ai's
  `Origin` behaviour is unmeasured.
- One Opus agent built both slices; lead reviewed mount.ts gate order,
  cors.ts, origins.ts, the conditional state writes and the SSE fault event
  line by line; gates re-run (unit 281, e2e 118) + mutation on the origin
  check. Nothing needed changing.
- Gotcha: Prisma generated a table rebuild for the `allowedOrigins` column;
  the agent hand-wrote a plain `ADD COLUMN … DEFAULT '[]'`.

## 2026-10-05 — Failing upstream visible on `/mcp`

- Roadmap "Next" 1. Lead wrote ADR-0022 and TC-90…93; a Sonnet agent built
  it; the lead reviewed `withUpstream`/unified list line by line, re-ran
  gates (unit 234, e2e 112) and a mutation check.
- Channel choice: a placeholder tool `xitl-status`, because tool descriptions
  are what every client hands the model; instructions arrive once per
  `initialize` and may not be shown. Flagged to Matthias as reversible.
- Changed after review: a call to `xitl-status` with nothing failing answers
  all-clear instead of "nicht bekannt" (clients cache the list).
- Checked: the SDK serializes only code/message/data of a thrown error, so
  the `cause` attached to `upstreamListError` stays server-side.
- Gotcha: Prisma named the migration with the current clock (sorting before
  `20261005200000_…`); renamed to `20261005210000_upstream_last_failure` (dev
  `_prisma_migrations` row renamed too). e2e needs
  `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright` in this shell.

## 2026-10-05 — Security fixes for `v0.4.1`

- Matthias approved the URL-change recommendation by asking for "the security
  fixes". Built by one Opus agent (it was interrupted once by an API 529 and
  resumed). The lead reviewed the PATCH transaction, DCR pruning and tool cap
  line by line and re-ran every gate: unit 226, e2e 108.
- The debt entries "no caps on held calls / SSE streams" were stale: both caps
  already exist per user (`lib/limits.ts`). Removed.
- Accepted leftovers (roadmap debt): the unbound-client cap isn't atomic under
  concurrent registrations, and registration spam can evict a client that is
  mid-consent. Both fail closed.
- A pruned stale tool loses its per-client rules (cascade) and comes back "Neu".

## 2026-10-05 — Outbound address policy (SSRF), header link, `v0.4.0`

- Roadmap caught up with reality: deployed, MG-01…04 passed (Matthias),
  MG-06 answered by the measurements; MG-05 (Tina) and MG-07 still open.
- SSRF fix (ADR-0020) by an Opus agent in two slices, the lead reviewed
  `lib/outbound.ts` and the wiring line by line. The check runs in the
  connection's own DNS lookup (undici Agent `connect.lookup`, https.Agent for
  web push), so DNS rebinding can't slip past; mutation runs proved the
  dispatcher is live.
- Matthias didn't want deploy config. He chose per-upstream confirmation
  ("Trotzdem erlauben") over automatic derivation, which would let a public
  host re-point its DNS inward, and over a global UI list. The env var stays
  as an optional admin override.
- Header title "xitl" links to Freigaben (Matthias).
- Gotchas:
  - `migrate dev` names folders from the workspace clock (UTC). The
    hand-named 2026-10-05 migrations sort later, so the new one was renamed
    to `20261005200000_…` (plus its `_prisma_migrations` row in dev.db).
  - undici must stay on 6.x while Node 22 bundles undici 6.
- Release `v0.4.0` at Matthias's request. Upstreams whose host resolves
  internally inside the pod need one "Trotzdem erlauben" per user after the
  deploy.

## 2026-10-05 — Grouping by time gaps, pause scopes

- Matthias chose time-gap grouping (10 min) plus day separators, and asked
  for pauses covering all tools / all read-only tools of an upstream
  (ADR-0019). Visual check on the dev app with temporary rows (removed).
  Grouping sorts by receivedAt itself (seeded rows exposed an id-order
  assumption). TC-56 race fixed (session links now also in Verlauf groups).

## 2026-10-05 — Measurement 2: nothing per chat

- v0.3.2 deployed (version footer). Ran 4 headless Claude Code "chats" x 2
  calls: own client via `/mcp` + token, and the claude.ai connector. Both
  2026-07-28; trace ids differ on every call; `claudecode/toolUseId` per call.
  Logged in ADR-0016. Token config deleted from the scratchpad; Matthias
  revokes the token.

## 2026-10-05 — Claude.ai measured: 2026-07-28, no sessions

- Matthias sent the "Diagnose" of a real Claude.ai call (v0.3.1): protocol
  2026-07-28, clientInfo `Anthropic/ClaudeAI 1.0.0`, UA `Claude-User`, no chat
  id in `_meta`; headers include `traceparent`, `x-cloud-trace-context`,
  `x-anthropic-client`. Logged in ADR-0016. Now storing their values (trace
  part only) per call to see whether one is stable per chat (TC-74 extended).

## 2026-10-05 — No sessions on the deployed instance

- Matthias: no sessions show up after deploying. No cluster access from here,
  so from the code: (1) the body peek skipped bodies without Content-Length,
  so a chunked `initialize` (HTTP/2 ingress) never created a session — real
  bug, fixed, TC-73 proves it; (2) a 2026-07-28-era client has no sessions by
  design. Added per-call diagnostics on every audit row (TC-74) so the next
  real calls show protocol version, clientInfo, header and `_meta` names.
- Grouping candidates for 2026-era clients: client-specific `_meta` keys or
  headers (diagnostics will tell), else time gaps per client.

## 2026-10-05 — Unified `/mcp`, token scope, `v0.3.0`

- Built the unified endpoint per ADR-0014; open points settled in ADR-0017
  (lead's calls, none changes the product promise): OAuth only (per-upstream
  tokens 401), first-`_` split, degrade per upstream, sessions with null
  upstream. server.ts now has one shared `listFor`/`callTool` for both
  endpoints. Schema: `McpSession.upstreamId` nullable.
- Sonnet agent wrote `e2e/tests/unified.spec.ts` (TC-61…68) blind to
  implementation details; no app defects found. e2e 80, unit 100.
- Matthias asked why a token for everything differs; answer: only reach
  (grows with new upstreams) and no expiry, policy still applies. He chose
  "all kinds of auth for all kinds of downstream": ADR-0018 token scope
  one/all, `allUpstreams` column with a consistency check in the verifier.
  TC-69…72 (Sonnet agent), e2e 84. Released `v0.3.0` at his request.
- Still open with Matthias: deploy + MG-01…07, upstream URL change.

## 2026-10-05 — Sessions, `v0.2.0`; next session starts on unified `/mcp`

- Matthias asked to group calls "per Claude chat". Built sessions + diagnostics
  first (ADR-0016) so MG-06 on real Claude.ai can show what identifies a chat.
  SDK finding: 2025-era clients get sessions; 2026-07-28-era (`server/discover`)
  has none; the SDK client doesn't re-initialize on 404 by itself.
- Released `v0.2.0` at Matthias's request. He compacts next; the next session
  builds the unified `/mcp` endpoint (roadmap "Next" lists the open points).
- Still open with Matthias: upstream URL change vs existing allow rules
  (roadmap); deploy + MG-01…06.

## 2026-10-05 — Per-upstream access tokens

- Matthias asked for static-header tokens per upstream as a second inbound
  method. Lead flagged that it reverses the siblings' "no static bearer" rule
  and shaped it to keep what that rule protected (ADR-0015); CLAUDE.md rule
  narrowed to "no *shared* static token".
- Unreleased on `main` together with slice 8. Open question to Matthias:
  upstream URL change vs existing allow rules (roadmap).

## 2026-10-04 (late) — Scheduled run: changed-tool rule, malicious-client suite

- Matthias answered before the run: changed tool vs explicit allow → ask (built);
  lock-screen approve for destructive tools stays (no change, ADR-0009).
- Slice 8 by an Opus agent; six real gaps fixed (roadmap archive). Lead
  reviewed policy precedence, revoke handling and middleware order; gates
  re-run: unit 78, e2e 59.
- New question for Matthias: what an upstream URL change should do to existing
  allow rules and HEADER secrets (roadmap).
- Gotcha: an early 413 makes Node close the socket mid-upload, so Playwright
  may report "socket hang up" instead of the status; TC-44 uses a raw request.

## 2026-10-04 — Briefing review, milestone 1 built, `v0.1.0`

- Matthias reviewed the briefing (a months-old summary): two separate users
  (ADR-0010), policies in the app not YAML (0011), inbound OAuth copied from
  Haushalt (0012), HTTP upstreams connected per user via OAuth (0013), both
  per-upstream and aggregated endpoints (0014), default `allow` permitted,
  5-min auto-deny, LLM review deferred, both users on Android.
- Built in three agent batches (Sonnet: registry + inbound OAuth; Opus:
  upstream OAuth + proxy + policy; Opus: approval + push + snooze + Verlauf),
  each reviewed line by line on the security paths and re-run by the lead.
- Open questions to Matthias (roadmap): explicit ALLOW vs rug pull;
  lock-screen approve for destructive tools.
- Gotchas: `@hono/node-server` swaps global `Response`, which breaks
  `instanceof Response` in the MCP SDK twice (auth gate, OAuth error parsing);
  both worked around, see comments. MCP client SDK refuses non-https token
  endpoints → upstreams via public URLs. `migrate dev` refuses new unique
  indexes non-interactively (CLAUDE.md has the workaround). Headless Chromium
  reports notifications as denied → TC-34 stubs the browser side.

## 2026-10-04 — Bootstrap

- Matthias brought a German briefing ("X in the Loop MCP Proxy") and asked for a
  third project on the sibling scheme. Briefing → `vision.md`, ADR-0002…0009,
  `ideas.md`, `roadmap.md`.
- Scaffold copied from haushalts-todos: Hono + Prisma 7/SQLite, Svelte 5 SPA,
  `scripts/app.sh` (3002/5175), e2e on :3202, Dockerfile, CI. Only `/api/health`,
  `/api/me` and a greeting page exist.
- Conflicts with the sibling scheme, taken to Matthias: consent-screen identity
  (ADR-0007, Proposed); auto-deny vs queue/resume (ADR-0004 follows the design
  doc). The briefing's "CLAUDE.md with devcontainer" is moot: the Coder
  workspace is the dev environment.
- Gotchas: `npm install` with `vitest` in the initial manifest crashed npm 10.9
  (`Cannot read properties of null (reading 'edgesOut')`); installing it
  afterwards with `npm install -D -w @xitl/api vitest` works. Prisma 7's
  `migrate dev` doesn't generate the client: run `npm run db:generate`.
