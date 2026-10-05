# Worklog

> One short entry **per working session**, newest first: where we left off, why,
> dead-ends, gotchas. Git covers the fine-grained "what".

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
