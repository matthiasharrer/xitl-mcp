# Architecture

> How the system fits together **right now**. Target design lives in the ADRs;
> this file describes what exists. _Last updated: 2026-10-07 (live Verlauf, ADR-0028; earlier 2026-10-05, v0.4.1: URL
> change resets trust, ADR-0021; unbound DCR clients pruned; KnownTool cap;
> earlier: unified `/mcp`,
> ADR-0017: all upstreams in one, `<slug>_` names; token scope one/all,
> ADR-0018: every endpoint takes OAuth and tokens; MCP sessions,
> ADR-0016: `Mcp-Session-Id` on 2025-era `initialize`, DB-backed, diagnostics;
> before that: changed tools vs explicit allow; malicious-client suite
> TC-38…49 and its fixes)._

## Current state: proxy with allow / deny / ask (held for approval on page or push)

Copied and adapted from `haushalts-todos` (ADR-0002, ADR-0012):

```
apps/api/   Hono on Node 22, Prisma 7 + SQLite (better-sqlite3 adapter, WAL).
            In production also serves the built SPA (static.ts, WEB_DIST).
  /api/health            no identity
  /api/*                 Sec-Fetch-Site guard (app.ts), then identity.ts
                         (Authelia Remote-User -> User row)
    /api/me
    /api/upstreams       routes/upstreams.ts: CRUD of the caller's upstreams,
                         POST /:id/connect, GET /oauth/callback (upstream OAuth),
                         POST /:id/tokens (access token, ADR-0015)
    /api/upstreams/:id/tools…  routes/upstreamTools.ts: policy UI API;
                         also GET/DELETE /:id/snoozes[/:snoozeId] (active
                         pauses, ADR-0026; each row has `purposeSource`)
    /api/running         routes/running.ts: "Läuft gerade" (TC-178…183):
                         GET my live Snooze rows (all upstreams/accesses,
                         soonest end first) + paused accesses; DELETE
                         /pauses = "Alle beenden" (every Snooze of the
                         caller; paused accesses stay). Changes are announced
                         by lib/pauseEvents.ts (emitted in createSnooze, the
                         snooze DELETE, the ADR-0029 mismatch deletion,
                         access pause/resume/delete, upstream URL change /
                         delete, tool change / prune) as the payload-free
                         `running` event on the approval stream
    /api/mcp/config      { configured } (is MCP_TOKEN set)
    /api/mcp/tokens      routes/mcpTokens.ts: create an all-upstreams token
    /api/mcp/clients     routes/mcpClients.ts: list/rename/revoke own clients (OAUTH and TOKEN kind)
    /api/approvals       routes/approvals.ts: my held calls, SSE stream, decide.
                         The stream also carries `history` (ADR-0028): one
                         Verlauf list row (routes/audit.ts serializeAuditRow)
                         per create/change of my audit rows, fed by
                         lib/auditEvents.ts (emitted in mcp/server.ts and
                         intent/store.ts); the row is re-read per stream with
                         the user in the query; and `running` {} ("Läuft
                         gerade" changed: re-read /api/running)
    /api/audit           routes/audit.ts: my call history (Verlauf)
    /api/sessions        routes/sessions.ts: my MCP sessions + diagnostics
    /api/push            routes/push.ts: VAPID key, subscriptions, test push
  /mcp/register, /mcp/token, /oauth/authorize, /.well-known/*
                         mcp/oauthRoutes.ts: DCR, PKCE, consent page;
                         mcp/unboundClients.ts prunes never-approved DCR clients
  /mcp/<slug>            mcp/mount.ts: bearer gate -> slug resolved among the
                         token user's upstreams -> session check/creation
                         (mcp/sessions.ts) -> mcp/server.ts (proxy core)
  /mcp                   same mount.ts path (serve(), slug null): OAuth or an
                         all-upstreams token (one-upstream tokens -> 401),
                         sessions without upstream -> server.ts buildUnified:
                         tools of every usable upstream in parallel, names
                         `<slug>_<tool>` (lib/unifiedNames.ts), a failing
                         upstream left out; calls split at the first `_`,
                         resolved among the user's upstreams, then the same
                         callTool() as /mcp/<slug>; unresolved -> DENY audited
                         without upstream. Instructions: proxyText.unifiedInstructions
  lib/auditEvents.ts     in-process AuditEntry change emitter (ADR-0028)
  lib/policy.ts          THE policy function (pure, policy.test.ts = TC-24)
  lib/limits.ts          every abuse limit in one place (TC-44/45/48/88/89)
  lib/limitedResponse.ts byte cap on upstream/AS responses (TC-48)
  lib/proxyText.ts       ask stamp, instructions prefix, agent messages,
                         audit excerpt, secret scrubber (pure, tested)
  lib/upstreamOAuth.ts   connect state, pending-auth checks, token expiry (pure)
  upstream/oauthClient.ts  xitl as OAuth CLIENT: discovery, DCR, PKCE, code
                         exchange, refresh (+ per-upstream refresh lock)
  upstream/connection.ts withUpstream(): one short-lived MCP client connection
                         per request, credentials injected by our fetch wrapper
  lib/outbound.ts        outbound address policy (ADR-0020): outboundFetch (the
                         only fetch), guarded DNS lookup, web-push agent,
                         save-time checkUrlHost, upstreamAllowance (the
                         per-upstream exception), OUTBOUND_ALLOW_PRIVATE
  upstream/tools.ts      KnownTool sync from tools/list
  approval/pending.ts    ApprovalHub: in-memory held calls + EventEmitter
  approval/budget.ts     300 s budget, approval deadline, snooze ends,
                         push summary (pure, budget.test.ts)
  approval/snooze.ts     Snooze rows (user-scoped queries)
  approval/notify.ts     hub -> Web Push (approval / resolved messages)
  approval/message.ts    the approval push payload (pure), and the
                         replacement push carrying the intent (ADR-0025)
  intent/                advisory intent summary from the local LLM
                         (ADR-0025): queue.ts worker, prompt.ts / parse.ts /
                         risk.ts / group.ts (pure), model.ts (llama.cpp via
                         outboundFetch + e2e stub), store.ts (DB side, boot
                         sweep), index.ts (env, wiring to the hub)
  pausecheck/            AI check of allow pauses (ADR-0029): prompt.ts
                         (state + /v1/systemone body, pure), check.ts
                         (PauseCheck seam, Clef client via outboundFetch,
                         strict parseAnswer, verdict, env), gate.ts (narrow
                         (pure) + PauseGate: evaluate, per-access serial
                         lock), outage.ts (in-memory outage per user),
                         text.ts (German notes), index.ts (instance + push)
  clef/                  the ONE Clef endpoint for all Clef features:
                         client.ts (clefEndpoint, transport via
                         outboundFetch, strict parseNoul / parseChoice,
                         withTimeout, clefFromEnv on PAUSE_CHECK_*),
                         index.ts (config + the background tool labeller)
  toolhint/              review hint of new/changed tools (ADR-0031):
                         defs.ts (canonical schema text, isCosmetic,
                         paramList, versionKey; pure), hint.ts (reviewHint,
                         pure), label.ts (Clef risiko/injektion framing),
                         queue.ts (HintQueue: background, once per version)
  auto/                  AUTO policy (ADR-0030): prompt.ts (state + question,
                         pure), gate.ts (resolveAuto pure + AutoGate),
                         draft.ts ("Vorschlag" prompt/parse, pure), text.ts
                         (card/push notes), index.ts (instance, shares the
                         pause gate's outage)
  lib/push.ts            Web Push sender, VAPID (AppSetting "vapid"),
                         PUSH_OUTBOX transport (copied from Haushalt)
  lib/clock.ts           injectable Clock (ADR-0003)
  lib/mcpOAuth.ts        signed-blob codes/tokens (HMAC with MCP_TOKEN), PKCE
  lib/externalOrigin.ts  the one definition of "our public origin"
  lib/slugs.ts           slug pattern + reserved words (register, token)
apps/web/   Svelte 5 SPA (Vite), German UI, mobile-first, installable PWA
            (manifest + icons + public/sw.js, push only). Tab bar:
            Freigaben (#/, live list of held calls; Verlauf and its detail
            are live too, ADR-0028, lib/historyLive.ts; #/freigabe/<id> one call,
            the push deep link), Verlauf (#/verlauf, #/verlauf/<id>),
            Einstellungen (#/einstellungen: Benachrichtigungen, upstreams with
            status, Verbinden/Neu verbinden, Regeln link, endpoint URL + copy,
            "Alle Upstreams" card with the /mcp URL;
            MCP clients; "Sitzungen ansehen" -> #/sitzungen, #/sitzungen/<id>)
            and Regeln (#/regeln/<id>, routes/Rules.svelte).
            "#/einstellungen?verbunden=<id>" / "?verbindung=…" carry the OAuth
            callback's result once (toast, then dropped from the URL).
e2e/        Playwright against the built server on :3202 with .e2e/e2e.db
            (output in .e2e/api.log) plus the fake upstream on :3210
            (e2e/support/fakeUpstream.ts) with its sink host on :3211.
            TC-01…TC-136 (TC-37 unit; malicious suite in
            malicious-client.spec.ts / malicious-upstream.spec.ts). The
            server runs with APPROVAL_TIMEOUT_MS=5000, PUSH_OUTBOX,
            OUTBOUND_ALLOW_PRIVATE=127.0.0.1:3210 (paths.ts; a spec that
            spawns its own server must pass it too) and the intent stub
            (INTENT_LLM_STUB=1, INTENT_LLM_STUB_LOG=.e2e/intent-stub.jsonl,
            INTENT_LLM_TIMEOUT_MS=3000; ADR-0025).
scripts/icons.mjs  rasterizes apps/web/public/icon.svg into the PWA PNGs
            (Playwright Chromium; rerun after changing the SVG).
```

### Upstream registry (ADR-0010, ADR-0013)

- Every query is scoped by `userId`; someone else's row is a 404, like a
  missing one. Responses go through the single `serializeUpstream` whitelist
  (routes/upstreams.ts): never a spread of the row. `headerValue` is write-only
  (the API only says `hasHeaderValue`), tokens/OAuth client/pending auth never
  leave the server.
- Status: OAUTH starts `NOT_CONNECTED`; HEADER/NONE are `CONNECTED` on create
  and when switched to (migration `header_none_connected` fixed older rows).
- Changing an upstream's `url` or `auth` drops stored tokens and OAuth
  registration (tokens must not follow to another server) and ends its held
  calls as denied (`+revoked`: never forwarded to the new server).
- A real `url` change resets trust (ADR-0021, TC-85/86): in one
  `prisma.$transaction` with the row update, every KnownTool of the upstream
  gets `changedAt = now`, `acknowledgedAt = null` ("Geändert": an explicit
  tool/client ALLOW becomes ASK `changed-tool` until acknowledged or its
  policy is set), and every Snooze of the upstream (all scopes) is deleted.
  Tool policies and client overrides are kept. If the resulting auth is
  HEADER, the PATCH must carry a new non-empty `headerValue`, else 400 `code:
  'header_value_required'` and nothing changes; without a URL change a
  missing `headerValue` keeps the stored one.
- Deleting an upstream ends its held calls as denied (`+revoked`, TC-41);
  its audit rows stay (`upstreamId` → NULL), so deciding afterwards is 409.
- Slugs: `^[a-z0-9][a-z0-9-]{0,31}$`, unique per user, `register` and `token`
  reserved (they are OAuth endpoints under `/mcp`).

### Upstream OAuth client (ADR-0013, TC-15…18)

- Built from `@modelcontextprotocol/client` 2.2's standalone helpers
  (`discoverOAuthServerInfo`, `registerClient`, `startAuthorization`,
  `exchangeAuthorization`, `refreshAuthorization`); the SDK's `auth()` /
  `OAuthClientProvider` orchestration is not used (single-session design,
  owns `state` itself, reads wall-clock time). State, storage, user binding
  and refresh locking are ours (`upstream/oauthClient.ts`).
- Flow: `POST /api/upstreams/:id/connect` -> discovery (RFC 9728 PRM, then
  RFC 8414 AS metadata) -> DCR if no registration for this issuer + redirect
  URI exists (`client_name: xitl`, public client) -> PKCE -> `pendingAuth`
  `{ state, codeVerifier, redirectUri, expiresAt (10 min, Clock) }` on the row
  -> `{ authorizationUrl }` (http(s) only). The browser goes to the upstream's
  AS and comes back to `GET /api/upstreams/oauth/callback` (under `/api`:
  Authelia + identity). Redirect URI = `externalOrigin + /api/upstreams/oauth/callback`.
- `state` = `<upstreamId>.<32 random bytes>`: the id is looked up among the
  CALLER's upstreams only (another user's state -> 400, nothing consumed), the
  secret part is compared timing-safe, then `pendingAuth` is cleared with a
  conditional update (single use) before the code is redeemed. Success ->
  `CONNECTED` + tokens, redirect `/#/einstellungen?verbunden=<id>`; AS error or
  failed exchange -> redirect with `verbindung=abgelehnt|fehler`; bad/used/
  expired state -> 400 German page.
- PRM `resource` must match the upstream URL by the SDK's
  `checkResourceAllowed` (same origin, upstream path under the resource path);
  another origin or another path on the same host -> connect refused (TC-46);
  otherwise it is sent as the RFC 8707 resource. Scope = PRM `scopes_supported`.
- AS metadata `issuer` must equal the AS URL (the SDK's RFC 8414 §3.3 check in
  `discoverAuthorizationServerMetadata`; IssuerMismatchError -> connect
  refused). A non-http(s) `authorization_endpoint` is refused by the SDK's
  metadata schema (javascript:, data:) or by `isNavigableUrl` (e.g. file:).
  Nothing is stored before all checks pass (the row is written last).
- Refresh (`refreshUpstreamTokens`): before a proxied request when expired or
  within 60 s of expiry (Clock), and once after a 401 (then the request is
  retried once). One refresh per upstream at a time (in-process lock; single
  replica). AS answers `invalid_grant`/`invalid_client`/… -> `NEEDS_RECONNECT`,
  tokens cleared, agent gets "Upstream „<Name>“ muss in xitl neu verbunden
  werden."; network/5xx -> generic upstream error, tokens kept. A second 401
  right after a successful refresh also means `NEEDS_RECONNECT`.
- `@hono/node-server` swaps `globalThis.Response`; the SDK's
  `parseErrorResponse` uses `instanceof Response`, so `oauthFetch` re-wraps
  every OAuth response in the current global `Response` (without that every
  token error parses as `server_error`). Same root cause as mount.ts's
  `isAuthInfo` guard.
- **Every** OAuth request (discovery GETs included) refuses redirects
  (`redirect: 'error'`, TC-47): a redirected POST would replay a code,
  verifier or refresh token elsewhere, a redirected discovery GET would let
  the upstream aim xitl's server-side requests anywhere. An AS whose metadata
  sits behind a redirect is unsupported. All OAuth requests time out after
  15 s and read at most `MAX_OAUTH_RESPONSE_BYTES` (1 MiB). The SDK refuses
  non-https token endpoints except loopback (deploy note: an in-cluster
  `http://…svc` upstream would fail to connect).
- Logs carry error class/code only (`errorTag`), never messages or bodies.

### Outbound address policy (ADR-0020, TC-77…84)

- Every server-side request to a URL xitl didn't choose goes through
  `lib/outbound.ts`: `outboundFetch` (used by `withUpstream`'s wrapper and
  `oauthFetchFor(row)`; nothing else calls `fetch`, a unit test scans for it) and
  `pushAgentFor` (the `https.Agent` handed to `web-push`).
- IP-literal hosts are classified before connecting. Names are checked in the
  connection's own DNS lookup: an `undici` 6 `Agent({ connect: { lookup } })`
  passed as `dispatcher` to Node's global fetch (npm undici major = the one
  bundled in Node 22; a unit test proves the lookup runs), and
  `https.Agent({ lookup })` for push. Any blocked address among the answers
  refuses the request (`OutboundBlocked`, logged with the hostname only).
  `outboundFetch` forces `redirect: 'error'` itself.
- **Per-upstream exception (the normal way):** `Upstream.allowInternal`.
  Create/PATCH with an internal URL answers 400 `{ error, code:
  "internal_address" }`; the form (`UpstreamSheet.svelte`) shows why plus
  "Trotzdem erlauben", which re-submits with `allowInternal: true`. The stored
  flag is `allowInternal === true && checkUrlHost(url) === 'blocked'`, so a
  public URL never carries it. A PATCH that changes the URL recomputes it; one
  that doesn't keeps it. Settings shows a flagged upstream as "intern".
  Enforcement: `upstreamAllowance(row)` = `[{host, port}]` of the row's current
  URL (default port filled in; `[]` unflagged), passed as `alsoAllow` to
  `outboundFetch` in `withUpstream` and in every OAuth call for that row
  (`startConnect`, `finishConnect`, refresh), built from the row read for that
  request. Any other host (an AS discovery names elsewhere) stays guarded
  (TC-83).
- **Admin override `OUTBOUND_ALLOW_PRIVATE`** (optional, empty by default;
  `host`, `host:port`, `[v6]:port`): a URL whose host (+port) matches skips the
  check for every user and push, using a plain dispatcher/agent. Parsed once at
  boot (malformed entries warn). By name, not by address. Such URLs count as
  not internal at save time, so they never get the flag. e2e uses it for the
  fake upstream.
- Save time: upstream create/PATCH URL and push subscribe call `checkUrlHost`
  (resolve all addresses; unresolvable is ok); push -> plain 400.
- Request time: a blocked upstream fails like an unreachable one (generic
  agent error); during connect -> German `ConnectError`; during refresh ->
  `RefreshUnavailable` (transient, tokens kept, not "reconnect").

### Self as upstream (ADR-0027, TC-130…131)

- `lib/selfLoop.ts`. Save time: create / URL-changing PATCH on xitl's own
  `externalOrigin(c)` → 400 `own_address`. Request time: `withUpstream`'s fetch
  and `oauthFetchFor` set `X-Xitl-Instance` (random per process, set after any
  configured header); a middleware in `app.ts` on `/mcp`, `/mcp/*`,
  `/oauth/*`, `/.well-known/*` answers 508 `loop_detected` to our own id,
  before auth/consent/DCR.

### Proxy core (ADR-0004, ADR-0008, ADR-0014, TC-19…23)

- `/mcp/<slug>` (and `/mcp`, next section) request handling stays stateless: `createMcpHandler(buildMcpServer)`;
  the factory is async and loads the upstream + user per request. mount.ts
  peeks at the JSON-RPC body (clone, ≤ 1 MiB = the body limit; chunked bodies
  without Content-Length are read too, capped — before v0.3.1 they were
  skipped, so `initialize` behind an HTTP/2 ingress got no session, TC-73) so only `initialize`/`server/discover` contacts the upstream
  for its instructions, and for session bookkeeping (next section).
- Upstream access: `withUpstream(upstreamId, userId, fn)` re-reads the row
  scoped by user, opens a `Client` + `StreamableHTTPClientTransport` with our
  own `fetch` wrapper (credential only to the upstream's origin, `redirect:
  'error'`, timeout 15 s connect / 120 s call, every response capped at
  `MAX_UPSTREAM_RESPONSE_BYTES` = 10 MiB via `limitResponse`: a declared
  larger Content-Length is refused unread, a streamed body errors once past
  the cap), runs `fn`, closes. ADR-0022: any failure after the connection
  states (refresh, connect, `fn`, other than NotConnected/NeedsReconnect) sets
  `Upstream.lastFailureAt` (Clock), a success clears it if it was set; the
  bookkeeping write never changes the outcome. Both writes are conditional
  (`recordFailure`: where `lastFailureAt: null`, so "since" is the first
  failure; `recordSuccess`: where not null); count 1 = a transition, emitted
  on `upstream/stateEvents.ts` (`upstreamStates`, in-process, cause
  `transition`). `markNeedsReconnect` is conditional on status not already
  `NEEDS_RECONNECT` (→ `reconnect` transition); `finishConnect` clears
  `lastFailureAt` and emits `ok`. Upstream PATCH (rename, URL/auth change —
  which also clears `lastFailureAt`) and DELETE emit cause `edit`.
  Listeners: `upstream/notify.ts` `wireUpstreamPush` (transitions into
  unreachable/reconnect only → push `{type:'upstream', upstreamId, name,
  state}`, TTL 1 h, `PushCooldown` 1 h per upstream across both states, in
  memory; `sw.js` shows it with tag `upstream-<id>`, tap → `/#/`), and the
  approval SSE stream (`upstreams` event = `faults.faultList(userId)`
  `[{id,name,state,since}]`, sent after `snapshot` and on every event of the
  user's upstreams, chained in order; also `GET /api/upstreams/faults`).
  Freigaben renders them as `FaultCard` ("Störung": Erneut prüfen = tools
  refresh / Neu verbinden = OAuth connect, which returns to Einstellungen).
  Settings shows such a CONNECTED row as "Nicht erreichbar" + "Erneut
  prüfen". It stores the upstream's instructions in
  `Upstream.instructions` when they change, scrubbed of our own credentials
  first (they are handed to agents, TC-48).
- `initialize`: instructions = prefix line ("Über xitl vermittelt … / Proxied
  by xitl …") + the upstream's instructions (live, else last seen, else the
  description, else the name). Only `tools` is advertised: **resources and
  prompts are not proxied** (out of scope for now).
- `tools/list`: not usable (OAUTH not connected / needs reconnect) -> `[]`
  without contacting the upstream; otherwise fetch, scrub our credentials out
  of the list (`scrubSecrets`, also in "Tools aktualisieren"), `syncKnownTools`,
  evaluate per tool for this client: DENY dropped, ASK description + stamp,
  ALLOW unchanged. At most `MAX_UPSTREAM_TOOLS` (500) tools are taken
  (`usableTools`; the rest are dropped with one log line, never recorded or
  listed, so calling one is `unknown-tool`). Upstream failure (incl. a
  response over the byte cap) -> JSON-RPC error with a generic message.
- KnownTool rows of tools that left the list stay, up to
  `MAX_KNOWN_TOOLS_PER_UPSTREAM` (1000) rows per upstream: past that, a sync
  deletes rows **not** in the current list, oldest `lastSeenAt` first, down
  to the cap (`staleToolsToPrune`; rows in the current list are never
  deleted), plus TOOL snoozes of the deleted names; client rules cascade. A
  deleted tool is `unknown-tool` DENY until listed again, then "Neu" (TC-89).
- `tools/call`: KnownTool + client override + upstream default + live
  allow/deny pauses read fresh -> `evaluatePolicy` -> AuditEntry `PENDING`
  written first (full arguments, `receivedAt` via Clock, endpoint,
  `approvalId` for ASK) -> DENY: `isError` (German + English; `snooze-deny`:
  `MSG.blocked`, naming the tool or the upstream and the end time), `DENIED`; ALLOW (rule or `snooze`): forwarded,
  result returned unchanged except that our own upstream credentials are
  scrubbed if the upstream echoes them (`scrubSecrets`), audit `FORWARDED` +
  `isError` + `resultText` (≤ 2000 chars), failure -> `UPSTREAM_ERROR`,
  generic message; ASK: held (next section). `forward()` in server.ts is the
  only place a call leaves xitl.
- **AI check of allow pauses (ADR-0029, `pausecheck/`).** Sits between
  `evaluatePolicy` (still pure, unchanged) and the audit write, and runs only
  when the decision is ALLOW with path `snooze` and `PAUSE_CHECK_URL` is set.
  Then, under a per-access (user + McpClient) promise chain
  (`PauseGate.serial`), the pauses are read and the policy evaluated again,
  and `PauseGate.evaluate` decides:
  - blind: the matched pause has no `anchorAuditId` (granted before the
    check) or `User.pauseCheck` is off;
  - otherwise one Clef `/v1/systemone` request (timeout
    `PAUSE_CHECK_TIMEOUT_MS`) with state = the anchor call (its audit row:
    tool, arguments, intent summary if DONE) + the calls forwarded under
    THIS pause since (`AuditEntry.pauseSnoozeId` = the pause's id, same user,
    client and upstream, outcome FORWARDED / UPSTREAM_ERROR / PENDING, newest
    `PAUSE_CHECK_MAX_SINCE` = 8, oldest first) + the new call.
  `narrow()` (pure) maps the result: match → ALLOW `snooze+ki`; mismatch →
  the Snooze row is deleted (no event, like "Aufheben") and ASK
  `snooze-ki-mismatch`; error/timeout/garbage/anchor row gone → ASK
  `snooze-ki-error`, pause kept; blind → unchanged `snooze`. It never turns
  anything else into ALLOW. The audit row then gets `pauseCheckScore`
  (p(gleich)), `pauseCheckChoice` (`gleich` or the stronger deviation) and,
  for an ALLOW via a pause, `pauseSnoozeId`. A held mismatch/error call
  carries `PendingCall.pauseCheck` (card note, push `note`).
  - **Which pause "matched":** `pauseState().allow` (snooze.ts
    `matchedAllow`): of the live ALLOW rows covering the call, the one with
    the latest `until`, ties → highest id. A mismatch ends that row only;
    another blind/covering row can still let the next call through.
  - **Settle path (TC-128 + ADR-0029 §6):** when the user's check is active
    at decision time, the approvals route does NOT settle covered held calls;
    server.ts does, right after `createSnooze` (anchor = the approved call),
    in `settleCovered`, in hub order under the same serial lock: match/blind
    → `pauseSnoozeId` (+ score) on the row, then `decide(approve, via
    'pause')`; mismatch → score on the row, pause deleted, `setPauseCheck`
    (SSE `checked`), stop; error → `setPauseCheck`, stop. The response's
    `alsoDecided` is then 0.
  - **Outage** (`outage.ts`, in memory): a model failure marks the user
    failing (SSE `pausecheck` {failing, since}, Freigaben card with "KI-
    Prüfung ausschalten"), one push `{type:'pausecheck'}` per start, at most
    one per user per hour; cleared by the next successful check or by
    `PATCH /api/me {pauseCheck:false}`. No probing. A restart forgets it.
  - The switch: `GET/PATCH /api/me` (`pauseCheck`, `pauseCheckAvailable` =
    URL configured). No /mcp path touches it. Since ADR-0030/0031 it is the
    switch of every Clef feature (UI "KI-Prüfung (Clef)").
  - **Purpose ("Wofür?", ADR-0029 amendment, TC-163…166):** the approve
    decision may carry `purpose` (≤ 200, one line, only with a duration;
    else 400), stored on `Snooze.purpose` (ALLOW only). With a purpose the
    state starts with "Purpose the human stated when granting the pause
    (trusted, written by the human):\n<purpose, `<` escaped, one line>" and
    the `richtung` instructions are prefixed "Does the new call serve exactly
    the purpose the human stated, in the same way as the anchor call? "
    (bench `clef_pause_intent.py`); without one the request is byte-identical
    to before. The checked call's audit row copies it (`pausePurpose`, and
    `pausePurposeSource`);
    `settleCovered` uses the new pause's purpose. Shown in Regeln (active
    Zeitfreigaben) and the Verlauf detail.
  - **Purpose suggestions (TC-172…177, Matthias 2026-10-07):** the intent
    model's `zweck_eng` / `zweck_art` (`AuditEntry.intentPurposeNarrow` /
    `intentPurposeKind`) are shown on the card as chips "Nur dies: …" /
    "Diese Art: …" ("KI-Vorschlag", only when a Zeitfreigabe is possible).
    A tap fills the field; approving with a Zeitfreigabe then sends
    `purposeSource: "suggested"` (`Snooze.purposeSource` 'typed' |
    'suggested', null without purpose; copied as
    `AuditEntry.pausePurposeSource`). Display only ("(Vorschlag)" in Verlauf
    and Regeln): the check treats both alike. A Sperre never takes a
    suggestion: the card sends no purpose for untouched chip text
    (`lib/purpose.ts`), the route answers 400 to deny + `suggested`, and
    `createSnooze` stores 'typed' for any non-ALLOW row. A source without a
    purpose → 400.
- **Sperre with a purpose (ADR-0026 amendment, `pausecheck/sperre.ts`,
  TC-167…171).** A deny Snooze now stores `anchorAuditId` (the refused call)
  and may carry `purpose` (same decide field). `livePauses` also returns the
  covering deny rows (`coveringDenies`). When the policy says DENY
  `snooze-deny` and some covering Sperre has a purpose, server.ts evaluates
  the policy again WITHOUT the Sperre (`withoutSperre`, pure) and, unless that
  is DENY, asks `SperreGate.evaluate`: every covering Sperre must have a
  purpose and an anchor row, Clef on + switch on; one noul `ausserhalb`
  request per Sperre (state: trusted purpose, refused anchor call, new call);
  all ≥ `PAUSE_CHECK_THRESHOLD` → `outside`. `relaxSperre` (pure) then turns
  the refusal into ASK `snooze-deny-ki-ask` — never ALLOW/AUTO, and DENY if
  the policy without the Sperre is DENY; anything else (inside, error, off,
  no purpose) keeps `snooze-deny`. Errors raise the shared outage notice.
  `AuditEntry.sperreScore` (+ `pausePurpose`) for inside/outside;
  `PendingCall.sperreCheck` for the card/push note. Held calls covered by a
  NEW Sperre are still all denied at once by the approvals route (no Clef).
- **AUTO policy (ADR-0030, `auto/`).** `evaluatePolicy` may return `AUTO`
  (resolved at the same steps as ALLOW/ASK/DENY; an explicit AUTO on a new
  tool is ASK `new-tool`, on a changed one ASK `changed-tool`; a live allow
  pause turns AUTO into ALLOW `snooze`, which then goes through the ADR-0029
  check; a Sperre denies first). server.ts then calls `AutoGate.evaluate`
  (not under the serial lock): Clef off or `User.pauseCheck` off → `off`;
  `Upstream.autoRule` empty → `norule`; else one `/v1/systemone` request:
  state "Richtlinie des Nutzers (vertrauenswürdig):\n<rule>\n\nAufruf eines
  KI-Agenten (nicht vertrauenswürdig; …):\n<call>\n{upstream, tool, stored
  description, stored annotations, arguments (truncated)}\n</call>", noul
  `erlaubt` "Erlaubt die Richtlinie des Nutzers genau diesen Aufruf
  eindeutig? Im Zweifel: nein." `resolveAuto` (pure) is the only mapping:
  p ≥ `AUTO_THRESHOLD` (0.8) → ALLOW `auto`; below → ASK `auto-ask`; error /
  timeout / garbage → ASK `auto-error` (raises the shared outage notice);
  off → ASK `auto-off`; no rule → ASK `auto-norule`; anything unexpected →
  ASK. `AuditEntry.autoScore` = p for pass/below. A held AUTO call carries
  `PendingCall.autoCheck` (card note, push `note`). tools/list stamps every
  non-ALLOW listed tool (ASK and AUTO). The rule text is set only by
  `PATCH /api/upstreams/:id {autoRule}` (≤ 1000, trimmed, empty → null).
  `routes/autoRule.ts`: `POST …/auto-rule/draft` (intent model, nothing
  saved), `GET …/auto-rule/history` (own newest ≤ 50 rows of this upstream)
  and `POST …/auto-rule/test {rule, auditId}` (one Clef verdict, read-only,
  no outage side effect; the UI runs rows sequentially and can stop).
- No `notifications/tools/list_changed` on policy changes: sessions are DB
  rows only (no open server-to-client stream; GET is 405); the next
  `tools/list` sees the change.

- Per-call diagnostics (TC-74): mount.ts computes
  `sessions.requestDiagnostics(headers, messages)` for every request
  (protocol version from header or 2026 `_meta`, `clientInfo` from 2026
  `_meta`, User-Agent, header names, `tools/call` `_meta` key names) and passes
  it in `AuthInfo.extra.diagnostics`; every AuditEntry stores it
  (`protocolVersion`, `clientInfo`, `userAgent`, `headerNames`, `metaKeys`).
  Shown under "Diagnose" in the Verlauf call detail. Purpose: find what
  identifies a chat when the client has no session (ADR-0016 measurement).

### Unified endpoint `/mcp` (ADR-0014, ADR-0017, TC-61…68)

- Same request path as `/mcp/<slug>` (mount.ts `serve(c, null)`): the gate
  takes OAuth or an all-upstreams access token (ADR-0018), no upstream is resolved, `AuthInfo.extra` gets
  `upstream: null, unified: true`. `server.ts callContextFrom` insists on
  exactly one of the two, otherwise it throws (fail closed).
- `server.ts` has one shared core: `listFor(upstream)` (list + policy filter +
  stamp of one upstream) and `callTool({upstream, endpoint, name, …})` (policy,
  audit, approval, forward). `buildSingle` (`/mcp/<slug>`) and `buildUnified`
  (`/mcp`) are thin wrappers around them, so rules, snoozes and approvals are
  one set per user whichever endpoint a call came through.
- `tools/list`: `Promise.allSettled` over all of the user's upstreams (rows
  read fresh, ordered by slug); unusable ones return `[]` without contact; a
  rejected one is left out (logged in `listFor`; ADR-0022: the user is told
  by push and the Freigaben card, the agent only by the instructions' state
  line; no placeholder tool). Names via
  `unifiedName(slug, tool)`; a name breaking `^[A-Za-z0-9_.-]{1,128}$` is
  skipped with a log line.
- `tools/call`: `splitUnifiedName` (first `_`; slug must pass `isUpstreamSlug`)
  -> `upstream.findUnique({userId_slug})` -> `callTool` with the upstream's own
  tool name and `endpoint: '/mcp'`. No split / no such upstream ->
  `denyUnresolved`: audit row `DENY`/`unknown-tool`/`DENIED` with
  `upstreamId: null` and the full name, nothing contacted.
- `initialize`: `unifiedInstructions` = prefix line + naming rule + one
  section per upstream (`## <name> — Tools \`<slug>_…\``, description, own
  instructions ≤ 4 000 chars). State lines (ADR-0022): not-connected and
  reconnect replace the body, unreachable sits above it. Live fetch from every
  usable upstream in parallel (10 s each; its outcome is the state), else the
  stored instructions and `storedState`.
- Sessions: `McpSession.upstreamId` is null for `/mcp`; `findOwnSession`
  matches `upstreamId` exactly, so the two kinds never match each other.
  UI shows "Alle Upstreams".

### Browser origins per token (ADR-0023, TC-96…99)

- `McpClient.allowedOrigins` (JSON text, default `[]`): TOKEN clients only.
  Set via both token-create routes (`allowedOrigins`) and `PATCH
  /api/mcp/clients/:id {name?, allowedOrigins?}` (OAuth row → 400
  `origins_token_only`; invalid → 400 `invalid_origin`). Validation in
  `lib/origins.ts` (`normalizeOrigin`: regex `scheme://authority/?` first,
  then `new URL().origin`; ≤ 10, deduped).
- `mcp/mount.ts` `serve()` order: (1) `OPTIONS` + `Origin` → `cors.preflight`
  before the bearer gate (204 + fixed headers if ANY token lists it —
  `originListedByAnyToken`: SQL `contains` narrows, exact JS check decides —
  else 403 bare); (2) bearer gate; a 401 gets CORS headers when the origin is
  listed by any token; (3) client row re-read `{id, userId}`; TOKEN + Origin
  not listed → 403 `origin_not_allowed`; (4) paused client (ADR-0024,
  `pausedAt` from the same row, TOKEN and OAuth) → 403 `access_paused`, with
  CORS only if (3) allowed the origin; (5) `touchTokenLastUsed` (moved out
  of the verifier so a refused request doesn't bump it); (6) slug, peek,
  sessions, handler — every response through `withCors` (headers only, body
  streamed) when allowed. OAuth clients: no check, no headers.
- No `cors()` middleware anywhere; nothing outside `/mcp` and `/mcp/<slug>`
  sends `Access-Control-*` (TC-97 checks `/api`, `/oauth`, `/mcp/token`,
  `/mcp/register`, `/.well-known`, static). Static/SPA paths answer
  `OPTIONS` with 204 `Allow: GET, HEAD` (`static.ts`; `serveStatic` skips
  OPTIONS, which it otherwise treats like HEAD: length, no body, hang).
  `/api/`, `/oauth/`, `/.well-known/` keep their 404.
- UI: TokenSheet field "Erlaubte Web-Adressen (Browser-Clients)", Settings
  token rows show "Im Browser erlaubt: …" + "Web-Adressen bearbeiten"
  (`OriginsSheet`).

### Pausing an access (ADR-0024, TC-102…105)

- `McpClient.pausedAt` (Clock). `PATCH /api/mcp/clients/:id {paused}`
  (combinable with `name`/`allowedOrigins`): `true` sets it only where null
  (first pause kept) and `approvals.cancelWhere(…, 'paused')` settles held
  calls (`+paused`, "resolved" push with outcome `paused`); `false` clears
  it. Serialized as `pausedAt` on every client.
- Gate step (4) above refuses every request. `server.ts` re-checks after an
  approval (`stillBound` selects `pausedAt`): paused → `+paused`, not
  forwarded. `/mcp/token` refresh is untouched and still mints for a paused
  OAuth client; the gate refuses using it.
- The "resolved" push also goes out for `revoked` (client revoked, upstream
  deleted/re-pointed) and `paused`, so the stale notification is replaced.
  `flood` calls were never announced, so none is sent for them.

### MCP sessions (ADR-0016, TC-55…60)

What the SDK (v2.2.0) and the protocol do — the reason for this shape:

- `createMcpHandler` classifies every request by era (body-primary,
  `classifyInboundRequest`). **2025-era** (`initialize` handshake, versions
  2024-11-05 … 2025-11-25, `SUPPORTED_PROTOCOL_VERSIONS`): served by the
  "legacy stateless fallback" — a fresh server + `WebStandardStreamableHTTPServerTransport`
  with `sessionIdGenerator: undefined` per POST; it never issues or checks
  `Mcp-Session-Id` (`validateSession` returns early) and answers GET/DELETE
  with 405. **2026-07-28 era** (`server/discover`, no `initialize`): every
  request carries a `_meta` envelope (`io.modelcontextprotocol/protocolVersion`,
  `…/clientCapabilities`, `…/clientInfo`) plus `MCP-Protocol-Version` /
  `Mcp-Method` headers; the transport is POST-only and **has no sessions at
  all**. Such clients stay sessionless here.
- SDK client (v2.2.0): default negotiation is `'legacy'` (initialize); it
  keeps the `mcp-session-id` from the initialize response, sends it on every
  request, `terminateSession()` sends DELETE (accepts 405). On a 404 it throws
  (`SdkHttpError`); it does **not** re-initialize by itself — the spec says
  the client MUST, so that is up to the client app. `versionNegotiation:
  {mode:'auto'}` probes `server/discover` first and goes modern against us.
- Our layer (mount.ts + `mcp/sessions.ts`), after the bearer gate and slug
  resolution: a 2025-era `initialize` (method `initialize` without the 2026
  envelope; any session id it carries is ignored) is served, and **if the
  response is 2xx** an `McpSession` row is created and its id added as
  `Mcp-Session-Id` to the response (body passed through, SSE keeps
  streaming). A failed insert just leaves the client sessionless. Any other
  request with `Mcp-Session-Id`: `findOwnSession` = same user + same McpClient
  + same upstream + `endedAt` null, else **404** with the SDK's own body
  (`-32001 "Session not found"`, JSON-RPC id echoed) — unknown, malformed,
  foreign and ended are indistinguishable. No header: sessionless, unchanged.
  Expiry (ADR-0016 amendment, TC-100): `pruneSessions` deletes sessions
  with `lastSeenAt` older than 30 days and, per user, the least recently seen
  over 500 — at boot (all users) and in `createSession` (that user,
  `reserve: 1`, failure only logged). Audit rows keep living (`SetNull`).
  `DELETE` with a valid id -> `endedAt`, 200 (the SDK's sessionful answer);
  without a header -> the handler's 405; invalid -> 404. GET -> 405.
- Ids: 32 random bytes base64url (43 chars). Not a credential: the token
  decides who acts; the session only labels rows. Stored in plain text.
- Per request with a session (`touchSession`, errors logged, never blocking):
  union of request header **names** (lower-cased, ≤ 100, each ≤ 100 chars),
  union of `_meta` **keys** of `tools/call` params (≤ 100, ≤ 200 chars),
  `callCount += number of tools/call messages`, `protocolVersion` updated from
  the `MCP-Protocol-Version` header (the negotiated version; the row starts
  with what `initialize` asked for), `lastSeenAt` written when anything else
  changes or at most once a minute otherwise. Values kept: only User-Agent
  (≤ 500, from initialize), clientInfo name/version (≤ 200), protocol
  version. Never Authorization or cookie values. Concurrent requests can lose
  a union update (read-modify-write); the count is atomic.
- The session goes to the proxy core via `AuthInfo.extra.session`
  (`{id, createdAt}`): `AuditEntry.sessionId` and the held call
  (`PendingCall.session`, in `/api/approvals` and the SSE events).
- Cascades: deleting the user, the McpClient (revoke) or the upstream deletes
  its sessions; audit rows keep living with `sessionId` set to null. Sessions
  never expire on their own (no TTL yet). Survive restarts (DB).
- Body peeking needs a declared Content-Length: a chunked `initialize` gets
  no session; a chunked request with a valid session is accepted but its
  `_meta` keys / call count are not recorded.
- CORS only for browser clients with an access token (ADR-0023, below);
  then `Mcp-Session-Id` is exposed.
- API (`routes/sessions.ts`, user-scoped, 404 for others): `GET
  /api/sessions?before=<id>` (newest first by createdAt, 50 per page, cursor
  must be the caller's own session), `GET /api/sessions/:id` (+ `headerNames`,
  `metaKeys`, its audit rows newest first, ≤ 200). Audit and approval APIs
  carry `session: {id, createdAt} | null`.
- UI: Einstellungen -> "Sitzungen ansehen" -> `#/sitzungen` (client, upstream,
  clientInfo, start, last seen, calls, protocol) -> `#/sitzungen/<id>` (facts,
  "Aufrufe in dieser Sitzung", "Diagnose": User-Agent, header names, `_meta`
  keys). `lib/SessionLine.svelte` ("Sitzung seit 14:02", a link; plain text
  inside Verlauf rows) on approval cards, the resolved approval page, Verlauf
  rows and the Verlauf detail.

### Approval: held calls (ADR-0004, ADR-0009, TC-27…31, TC-37)

- **Client cancel (TC-132):** `createMcpHandler` is stateless per HTTP
  request, so the SDK can't route a later `notifications/cancelled` to the
  request it names. `mcp/mount.ts` (after the gate, session lookup) passes
  every such message in a POST to `approvals.cancelByRequest({userId,
  mcpClientId, sessionId, endpoint}, requestId)`; held calls carry
  `request: {endpoint, rpcId}` (`reqCtx.mcpReq.id`, set in server.ts). Exactly
  one match → settled `aborted` (deny, `+aborted`); zero or several → no-op.
  The message still reaches the handler (202).

- `approval/pending.ts` `ApprovalHub` (one per process, `approvals`): a Map of
  held calls keyed by a 128-bit random id (base64url, 22 chars) with userId,
  client, upstream, tool, args, audit id, rule path, `receivedAt`,
  `deadline`, `snoozable`, `session` (ADR-0016, or null). `hold()` returns a promise that settles **exactly
  once**: the first of `decide()` (owner only; another user's id = not found),
  the deadline timer (`setTimeout` from the Clock's delta), `abort()` (the MCP
  request's `ctx.mcpReq.signal`: the client hung up), `cancelWhere(pred)`
  (`revoked`: client revoked in `DELETE /api/mcp/clients/:id`, upstream
  deleted or its url/auth changed in routes/upstreams.ts) or `shutdown()`
  (SIGTERM in index.ts). The entry leaves the Map synchronously when it
  settles. **Cap (TC-45):** `hold()` counts the user's held calls and inserts
  in the same synchronous step; at `MAX_HELD_CALLS_PER_USER` (10) the new call
  settles at once as `flood` and emits nothing (no SSE event, no push). Events
  `pending` / `resolved` / `shutdown` feed the channels (SSE, push);
  listener errors are swallowed so a channel can't break a decision.
- Budget (`approval/budget.ts`): 300 s from `receivedAt` for wait + upstream.
  Deadline = `receivedAt + min(APPROVAL_TIMEOUT_MS, 300 s − 5 s)`
  (`APPROVAL_TIMEOUT_MS` env, default 300 000; e2e 5000). After an approval
  the upstream timeout = what is left, capped at 120 s; under 5 s left ->
  `TIMED_OUT` without forwarding.
- Outcomes (audit `decisionPath` = `<rule>+…`, `decidedAt` = decision time):
  approve -> forward, `FORWARDED` `+approved:page|push` (snooze row written if
  asked); deny -> `DENIED` `+denied:page|push`, agent text names the user
  (with a deny pause, ADR-0026: the DENY row is written first, then the agent
  gets `MSG.blocked`; if storing fails the call is denied all the same);
  timeout -> `TIMED_OUT` `+timeout` ("nicht innerhalb von 5 Minuten
  freigegeben … später erneut versuchen"); client abort -> `DENIED`
  `+aborted`; shutdown -> `DENIED` `+shutdown`; revoked -> `DENIED`
  `+revoked` ("… Client widerrufen oder der Upstream entfernt …"); over the
  cap -> `DENIED` `+flood` ("Zu viele offene Freigaben …"). An approval is
  only forwarded if the client row still exists for the user (re-checked
  after the decision: a call that slipped into the hub after `cancelWhere`
  still ends `+revoked`). At boot, any audit row still
  `PENDING` (crash/kill) becomes `DENIED` `+restart` (index.ts).
- `/api/approvals` (routes/approvals.ts, behind identity, all user-scoped):
  `GET /` (my held calls, with `remainingMs` so the client's countdown doesn't
  depend on clock agreement), `GET /stream` (SSE via Hono `streamSSE`:
  `snapshot` on connect, then `pending` / `resolved` / `intent` (ADR-0025)
  for the caller's calls only; keepalive comment every 25 s; ends on shutdown; at most
  `MAX_APPROVAL_STREAMS_PER_USER` (5) open per user, the next -> 429, counted
  per route instance and released in the stream callback's finally), `GET /:id` (pending,
  or `{state:'resolved', outcome, decisionPath, …}` from the audit row by
  `approvalId`), `POST /:id` `{decision, via:'page'|'push', snoozeMinutes? |
  snoozeUntilMidnight?, snoozeScope?}` (strict zod; 404 unknown/foreign id,
  409 "Diese Freigabe ist nicht mehr offen." when the audit row is the
  caller's; an allow pause on a non-snoozable call -> 400; deny + duration =
  deny pause (ADR-0026), needs `snoozeScope` `tool`|`upstream` (missing or
  `readonly` -> 400), allowed for new/changed tools too since it only
  tightens; same duration limits as the allow pause). The Sec-Fetch-Site guard
  applies (the service worker's fetch is same-origin).
- The MCP response for a held call: the SDK's legacy (2025-06-18) stateless
  leg answers over SSE and sends `: keepalive` comments every 15 s while the
  handler waits, so idle proxies see traffic.

### Intent summary (ADR-0025 + amendment, TC-106…120, TC-126)

Advisory only: **nothing on the decision path reads or waits for it** (policy,
hold/decide, timeout, forwarding), and the agent's result never contains it.
Any model/DB failure ends as `FAILED` (or nothing) for that call only.

- **Switch:** `INTENT_LLM_URL` (base URL; `/v1/chat/completions` appended unless
  already there) turns it on; `INTENT_LLM_MODEL` (default `qwen`, a llama.cpp alias; the `model` the server answers with is stored as `intentModel`),
  `INTENT_LLM_API_KEY` (bearer, never logged), `INTENT_LLM_TIMEOUT_MS` (≤ and
  default 60 s), `INTENT_LLM_THINK_BUDGET` (thinking tokens, default 128,
  capped at `INTENT_THINK_BUDGET_MAX` 1024, `0` = thinking off, unparsable or
  negative = 128; `model.ts intentThinkBudgetFromEnv`). `INTENT_LLM_STUB=1` selects the deterministic stub instead
  (e2e only; `INTENT_LLM_STUB_LOG=<file>` records each request's messages as a
  JSON line). Read once in `intent/index.ts` (`intents`, the process-wide
  `IntentQueue`; model null = off).
- **Audit columns:** `intentStatus` (`OFF` feature off | `PENDING` queued |
  `DONE` | `FAILED` | `SKIPPED` queue overflow, restart, or an unresolved
  `/mcp` name), `intentTitle` (TC-126: the model's 3–5-word German title,
  one line, control characters removed, ≤ 60 chars; null if absent),
  `intentSummary` (intent + " Auffällig: " + concerns, ≤ 600),
  `intentRisk` (shown), `intentModelRisk`, `intentLowered`, `intentModel`,
  `intentAt`, `intentPrompt` + `intentAnswer` (the exact user turn and raw
  answer, replayed byte-identically; never exposed), `intentContextId` (audit
  id of the context's first call, indexed), `intentPurposeNarrow` /
  `intentPurposeKind` (TC-172: the two suggested Zeitfreigabe purposes, ≤ 120,
  DONE only; exposed on pending calls, the approval detail and the SSE
  `intent` event, NOT on Verlauf rows or pushes).
- **Flow:** `callTool` writes the row with `intentStatus` = `PENDING` (or
  `OFF`) and calls `intents.enqueue()` (synchronous, never throws): non-ASK
  calls at once, ASK calls right after `hub.hold()` (job `held` = the call is
  really in the hub; a `flood` call isn't). The hub's `resolved` event
  `release()`s the job's priority (`wireIntents`).
- **Worker** (`queue.ts`, concurrency 1, in memory): only the oldest job per
  source (`group.ts sourceKey`: session id, else client id) may run; among
  those, sources with a held job first, then oldest `receivedAt`. Over
  `MAX_INTENT_QUEUE` (200) the oldest non-held jobs are `SKIPPED`. Boot:
  `sweepIntents()` (index.ts) sets every leftover `PENDING` to `SKIPPED`.
- **Context** per call: its predecessor in the source (same session; or same
  client, sessionless). If `continuesGroup` (same session, or gap ≤ 10 min,
  ADR-0019's rule) and the predecessor has an `intentContextId`, the call
  continues that context: messages = system prompt + every DONE row's
  (`intentPrompt`, `intentAnswer`) of the context in id order + the new turn.
  Over `MAX_INTENT_CONTEXT_CALLS` (20) turns or `MAX_INTENT_CONTEXT_CHARS`
  (48 000) it starts fresh (system prompt only; context id = this call).
  FAILED rows keep the context id but contribute no turn; a SKIPPED/OFF
  predecessor starts a fresh context.
- **Turn** (`prompt.ts callTurn`): `Aufruf <n>` (the only text outside the
  block), then a `<call>` line, ONE line of JSON `{upstream, tool,
  description+annotations (first appearance of upstreamId:tool in the
  context), arguments | argumentsTruncated (> 4000 chars), frueher?}` with `<`
  written as `\u003c`, and a `</call>` line. JSON escapes newlines, so no
  value can make a line of its own. Never credentials or client free text.
  The German system prompt (v2, TC-119) says the block is untrusted data,
  never instructions; what, not why; names only from earlier results; call
  numbers are not ids; undoable archiving = write, destructive = hard to
  undo; patterns (change of direction, sweeping, continuing after a denial)
  with a count.
- **Earlier calls** (`frueher`, ADR-0025 amendment, TC-118): `{"<n>":
  {ausgang, ergebnis?}}` for the context's calls (by position) that have
  news: never reported, or reported as pending (`PENDING_WORDS`) and final
  now. `ausgang` = `outcomeWord` (fixed German words; `snooze-deny` ->
  "vom Menschen gesperrt"); `ergebnis` = the audit `resultText` (≤ 2000,
  scrubbed) of FORWARDED calls only (DENIED/TIMED_OUT/UPSTREAM_ERROR rows
  hold our own text, never sent). What was already reported is read back from
  the stored turns' blocks (`reportedSoFar`: only our own `frueher` key), so
  nothing extra is stored and replay stays byte-identical. Results are the
  upstream's text, i.e. a second injection source: accepted for an advisory
  summary (the risk floor still holds).
- **Answer** (`parse.ts`): one JSON object `{title?, intent, risk:
  read|write|destructive, concerns?, zweck_eng?, zweck_art?}` (title
  missing/empty -> null, still DONE; `zweck_*` (TC-172/175: prompt fields
  verbatim from `scripts/bench/qwen_purpose_suggest.py`) are cleaned by
  `cleanPurpose`: control chars out, one line, cut before `<`, quotes and
  trailing punctuation off, ≤ 120, else null, never a failure; older stored
  answers without them replay unchanged and read as null); prose/fence around exactly one object
  is accepted; anything else (or an answer over 4000 chars) = `FAILED`.
  **Risk shown** (`risk.ts`) = max(`toolHint` of the stored annotations, model)
  on read < write < destructive; model lower than the hint -> `intentLowered`.
- **Model** (`model.ts requestBody`): `POST …/chat/completions {model,
  messages, max_tokens = INTENT_ANSWER_MAX_TOKENS (400 since the purpose suggestions) + budget, temperature
  0.2, chat_template_kwargs.enable_thinking (budget > 0),
  thinking_budget_tokens (only when > 0; llama.cpp's per-request field,
  `reasoning_budget` is ignored by it), response_format json_object}`. Only
  `choices[0].message.content` is the answer; `reasoning_content` is never
  read, parsed or stored (content missing -> FAILED). Via `outboundFetch` with
  `alsoAllow` = exactly the URL's host:port (`upstreamAllowance` shape;
  redirects refused there), response capped at 256 KiB, aborted by the
  worker's timeout. Logs one info line per request: duration, `prompt_n`,
  `cache_n` (numbers only).
- **Channels:** the queue emits `intent` {auditId, userId, approvalId, view};
  `wireIntents` calls `hub.setIntent()` for a still-held call (stores the view
  on the PendingCall, emits hub `intent`; can't settle anything). SSE event
  `intent` `{id, intentStatus, intentTitle, intentSummary, intentRisk,
  intentLowered}`; `serializePending` (list, snapshot, `GET /:id`) carries the
  same fields. `approval/notify.ts` re-sends the `approval` push for a DONE
  summary with `update: true`, `intent` (≤ 200), `intentTitle` (≤ 60, if any),
  `risk` (urgency normal); sw.js shows it silently with the same tag **only if
  a notification with that tag is still open**, else drops it; the title is
  the body's first line, the heading stays "Freigabe nötig".
- **API:** `/api/audit` list + detail and the resolved `/api/approvals/:id`
  expose `intentStatus`, `intentTitle`, `intentSummary`, `intentRisk`,
  `intentLowered`, `intentAt`, `intentModel` (title/summary/risk/lowered only
  when DONE); so do the session detail's entries (`/api/sessions/:id`). Never
  prompt, answer, model risk or context id.
- **Web:** `lib/IntentSummary.svelte` (plain text; "KI-Zusammenfassung ·
  beratend", chip Lesen/Schreiben/Destruktiv, warning "KI schätzt das
  harmloser ein als das Tool selbst", "Zusammenfassung wird erstellt…" while
  PENDING, "Keine Zusammenfassung" on FAILED, nothing on OFF/SKIPPED) on the
  approval card, the resolved approval page and the Verlauf detail (with model
  and time). The card's arguments sit in an expandable "Rohdaten" when the
  feature is on (open if the summary wasn't there when the card appeared).
  TC-126: `lib/CallWhat.svelte` makes the title the card's / approval detail's
  headline with "tool · Upstream" (monospace tool) as the meta line; without a
  title the classic "Upstream · tool" line; while PENDING a placeholder bar of
  the title's height is reserved so the live switch doesn't move the card.
  Verlauf and session detail rows do the same (title as headline, tool in the
  meta line). Plain text everywhere, never `{@html}`.

### Snooze / pauses (ADR-0004, ADR-0019, ADR-0026, TC-30, TC-76, TC-121…125)

`Snooze` rows (user, upstream, client, `scope`, `effect`, `toolName`,
`until`). `effect` (ADR-0026) is plain TEXT, default `ALLOW` (the allow
pause below); anything other than exactly `ALLOW` is a **deny pause**
(`snooze.isAllow`, fail closed). Scope
`TOOL` (toolName set), `READONLY` (every tool of the upstream whose STORED
`KnownTool.annotations` say readOnlyHint, `snooze.isReadOnly`) or `UPSTREAM`
(every tool); toolName null for the wide two. Created when an approval
carries `snoozeMinutes` (1…1440; UI: 15, 60) or `snoozeUntilMidnight` (next
00:00 Europe/Berlin, DST-safe), plus optional `snoozeScope`
(`tool`|`readonly`|`upstream`; `readonly` only for a read-only held call,
else 400; a scope without a duration is 400). server.ts narrows anything
unexpected to `TOOL`. Lookups always filter by (userId, upstreamId,
mcpClientId) and `until > now`; `snooze.pauseState` (pure, unit-tested)
splits the live covering rows by effect: `allowUntil` (only `ALLOW` rows) and
`denyUntil` + `denyScope`. `livePauses(owner, tool, readOnly, now)` (tools/call)
returns both; `liveSnoozeUntil` / `liveSnoozesFor` (tools/list) return
`allowUntil` only, so a deny row never acts as an allow, and a deny-paused
tool stays listed (no `list_changed`; the call error explains).
**Deny pause:** `evaluatePolicy` gets `denyPausedUntil`; right after
unknown-tool, a value not provably expired (valid `until` ≤ valid `now`)
is `DENY` `snooze-deny`, beating client/tool ALLOW, the upstream default,
an allow pause and new/changed tools. Created only from the app (card /
approval detail: "Ablehnen und nicht mehr fragen bei …", scope dieses Tool /
ganz <Upstream>, 15 Min. / 1 Std. / Heute) by `createSnooze(…, 'DENY')` in
server.ts's deny branch. **Allow pause:** `evaluatePolicy` gets that
`snoozedUntil` + `now` and upgrades **only ASK, and never for a tool awaiting
review** (`awaitingReview`: new or changed, whatever path said ASK) to ALLOW
`snooze`; DENY and unknown tools never. An annotation change marks a tool
changed, so relabelling a tool read-only can't slip under a READONLY pause.
The held call carries `snoozable` (`!awaitingReview`) and `readOnly`.
tools/list applies it too (no stamp while snoozed). A rug-pull re-flag deletes
the tool's TOOL snoozes (wide ones stay but can't apply while it awaits
review). Expired rows are pruned when a new one is written.
**Active pauses** (TC-124): `GET /api/upstreams/:id/snoozes` lists the
caller's live rows of that upstream, both effects (`{id, effect, scope,
toolName, mcpClientId, clientName, until, createdAt}`, sorted by `until`),
`DELETE …/snoozes/:snoozeId` lifts one (the only edit; foreign upstream or
row -> 404) and answers the fresh list. Regeln shows them as "Aktive Zeitfreigaben und Sperren"
(chip Erlaubt/Gesperrt, scope, client, until, "Aufheben") when any exist.

### Grouping (ADR-0019, TC-75)

UI only: `apps/web/src/lib/grouping.ts` (unit-tested, `npm run test:unit`
runs it with TZ=Europe/Berlin). Verlauf: day sections (Heute/Gestern/date,
browser time zone), then groups per session id, else per client id (name for
revoked clients) with ≤ 10 min between consecutive calls; sorted by
`receivedAt`, newest first. Freigaben: same groups, headers only when > 1.
`/api/audit` rows and pending approvals carry `clientId` for this.

### Rug pull (TC-36) and review hint (ADR-0031, TC-149…154)

`syncKnownTools` compares each known tool's stored description, annotations
(canonical JSON, key order ignored) and, since ADR-0031, `inputSchema`
(stored canonically, keys sorted, always a string — "null" when absent —;
over 16 000 chars a prefix + sha256) with the new list. A NULL stored schema
(row from before the migration) is filled in silently. A description-only
change that differs only in whitespace, punctuation (Unicode P*) or case is
**cosmetic**: not a change; on an acknowledged tool it is recorded as the
auto-acknowledgement `auto-ack:cosmetic` (`cosmeticAckAt`, `prev*` = old
text); on a tool awaiting review nothing about the review state changes.
Every other difference is a change as below; `prevDescription`,
`prevAnnotations`, `prevInputSchema` keep the acknowledged definition (first
change wins until acknowledged); a URL change (ADR-0021) also sets
`urlChanged`. Acknowledge / set policy clears all of them.
`toolhint/hint.ts reviewHint` (pure) gives a new/changed tool *attention*
reasons (readOnly lost, destructive/openWorld newly true — for a new tool:
true at all —, new parameter (required or not), removed / retyped / newly
required parameter, unparseable schema change, description grown > 50 % or
> 400 chars, URL changed, changed without a stored previous version) plus the
Clef label's (risiko above the annotations' claim; injection ≥ 0.5). After
each sync `HintQueue` (fire and forget, one tool at a time process-wide)
labels tools awaiting review whose `hintFor` ≠ `versionKey`: two Clef
requests (risiko choice, German criteria; injektion noul, English question,
description + parameter descriptions as one escaped JSON line in `<data>`);
failures leave the label NULL and still mark the version (no retry storm);
off when Clef or the owner's switch is off. Nothing on the call path reads
it; it never acknowledges. `GET …/tools` returns `review` {review,
attention, reasons, label, pending}, `parameters`, `previous`, `annotations`,
`cosmeticAckAt`; `POST …/tools/acknowledge-unremarkable` acknowledges the
new/changed tools without attention and without a pending label (judged
server-side, each write conditional on the judged definition). A held
new/changed call carries `PendingCall.toolReview` (snapshot at hold time).

Before ADR-0031 the comparison covered only description and annotations. A change
on **any** known tool (acknowledged or still "Neu": a per-client ALLOW can be
set on a "Neu" tool without acknowledging it) clears `acknowledgedAt`, sets
`changedAt` (UI "Geändert" instead of "Neu"; `isChanged` = `changedAt` set in
the tools API) and deletes its snoozes; the write is conditional on the row
still holding the old definition. Acknowledge / set policy clears `changedAt`.
**A changed tool never resolves to ALLOW (or AUTO)** (Matthias, 2026-10-04): an explicit tool- or client-level ALLOW
becomes ASK `changed-tool`; an explicit ASK or DENY applies unchanged (a
changed DENY tool stays hidden and denied); no rule -> ASK `changed-tool`.
The Regeln view's "Gilt" uses the same function, so it shows "Fragen
(geändertes Tool)" for such a tool.

### Web Push (ADR-0009, TC-32…34)

- Copied from Haushalt: VAPID pair generated on first use in `AppSetting`
  "vapid"; `PushSubscription` per device (upsert by endpoint, moves to the
  caller); 404/410 deletes; `PUSH_OUTBOX=<file>` swaps the transport for a
  JSONL file. `web-push` sends with `urgency` + `TTL`.
- `approval/notify.ts` listens on the hub: each new held call ->
  `{type:'approval', id, upstream, tool, summary, expiresAt}` (summary = tool +
  first argument values, one line, ≤ 120 chars; no client name, no full args,
  no credential; payload checked ≤ 4000 bytes) to **the owner's**
  subscriptions, urgency high, TTL = seconds to the deadline. Decided on the
  page or expired -> `{type:'resolved', id, outcome}` so the worker replaces
  the stale notification (not after a decision from the notification itself,
  not on abort/shutdown).
- `apps/web/public/sw.js` (no fetch handler, no caching): `approval` ->
  notification (tag `approval-<id>`, `requireInteraction`, actions
  Erlauben/Ablehnen, data.url `/#/freigabe/<id>`); action -> `fetch POST
  /api/approvals/<id> {decision, via:'push'}` with `credentials: 'include'`,
  `redirect: 'manual'` (an expired Authelia session's redirect is not
  followed), then the notification is replaced by the outcome (Erlaubt /
  Abgelehnt / Nicht mehr offen / bitte in der App anmelden); body tap ->
  focus/open `/#/freigabe/<id>` (iPhones show no actions: that is the whole
  path there). `resolved` -> replace by tag, silent. `test` -> plain.
- Web: `lib/push.ts` (subscribe/unsubscribe/test, and on every app start
  re-registers an existing subscription with the server), Einstellungen
  "Benachrichtigungen" card. `index.html` links the manifest with
  `crossorigin="use-credentials"` (Authelia) and the apple-touch-icon.

### Audit API (ADR-0008, TC-35)

`GET /api/audit?before=<id>` (newest first by id, 50 per page, `nextBefore`),
`GET /api/audit/:id` (arguments parsed, result excerpt, times). Both carry
`session: {id, createdAt} | null` (ADR-0016) and the intent fields
(ADR-0025, see "Intent summary"). User-scoped;
another user's id is 404. The UI renders `decisionPath` in German
(`decisionPathText` in web `lib/api.ts`).

### Policy engine (ADR-0004, TC-24, TC-30)

`lib/policy.ts` `evaluatePolicy({ upstreamDefault, tool: { policy,
acknowledgedAt, changedAt } | null, clientOverride, snoozedUntil?, now? })`
(`changedAt` is required in the type on purpose): unknown tool (no KnownTool)
-> DENY `unknown-tool`; client override -> `policy:client`; tool policy ->
`policy:tool`, except that an ALLOW from either becomes ASK `changed-tool`
when `changedAt` is set; changed, no rule -> ASK `changed-tool`;
unacknowledged (new) -> ASK `new-tool`; else default ->
`policy:upstream-default`; then a live snooze turns ASK (or AUTO) into ALLOW
`snooze` unless the tool is awaiting review (new or changed). `changedAt` set
counts as changed even with `acknowledgedAt` set (fail closed). Non-Policy
values (anything but ALLOW/ASK/DENY/AUTO) fail closed to DENY. AUTO
(ADR-0030): explicit AUTO on a changed tool → ASK `changed-tool`, on a new
one → ASK `new-tool`; an AUTO result is resolved by `auto/gate.ts
resolveAuto` (see Proxy core). Note: Prisma rejects an unknown enum value
when reading the row, so a corrupted `Upstream.defaultPolicy` fails the
request (no audit row, nothing forwarded) before the engine sees it.

KnownTool rows come from every upstream `tools/list` (proxy or "Tools
aktualisieren"). The **first** list ever seen for an upstream is recorded as
acknowledged (`ACKNOWLEDGE_INITIAL_TOOLS` in upstream/tools.ts): the new-tool
rule is for tools the upstream adds later. Any later new tool is `acknowledgedAt
= null` until the user sets a policy for it or acknowledges it.

### Policy UI API (TC-25, TC-26)

`GET /api/upstreams/:id/tools` (tools with hint from annotations —
readOnlyHint -> Lesen, destructiveHint true -> Destruktiv, else Schreiben —,
own policy, effective policy without client override, path, `isNew`,
`isChanged`, the
caller's client overrides; plus the caller's clients), `POST …/tools/refresh`,
`PATCH …/tools/:toolId` `{ policy | null }` (sets `acknowledgedAt`, clears
`changedAt`),
`POST …/tools/:toolId/acknowledge`, `PUT/DELETE
…/tools/:toolId/clients/:mcpClientId`. The upstream is resolved among the
caller's, the tool through that upstream, the client among the caller's (OAuth
clients, token clients of exactly this upstream, and all-upstreams tokens,
ADR-0018 / TC-127; `clients` lists the same set, paused ones included, with
`paused` for the "pausiert" chip): 404 otherwise.

### Request limits (TC-44)

`app.ts`, Hono `bodyLimit`, registered before identity and every route:
`/api/*` JSON bodies ≤ `MAX_API_BODY_BYTES` (64 KiB) -> 413 "Die Anfrage ist
zu groß."; `/mcp`, `/mcp/*`, `/oauth/*` ≤ `MAX_MCP_BODY_BYTES` (1 MiB) -> 413.
A declared Content-Length over the limit is refused on the header alone
(before the token check, before any DB access); a chunked body is buffered
only up to the limit. Node closes the connection after an early 413 while
the client is still sending, so clients may see a reset instead of the
status (e2e reads it with a raw request that sends only part of the body).
Tool names over 200 chars are audited truncated and denied as
`unknown-tool`; non-object `arguments` are rejected by the SDK's schema
(JSON-RPC error, no audit row).

### CSRF backstop

`app.ts`: unsafe methods under `/api/*` with `Sec-Fetch-Site` other than
`same-origin`/`none` -> 403. Non-browser callers (no header) pass. Authelia's
SameSite cookie is the first line; this covers body-less POSTs like
`acknowledge` and `connect`.

### Inbound MCP OAuth (ADR-0012, ADR-0014)

- Copied from Haushalt: stateless signed codes/tokens (`MCP_TOKEN` is the HMAC
  secret, **never** a bearer), 1 h access / 30 d refresh, DCR creates a
  `McpClient` row (`createdAt` and `client_id_issued_at` from the Clock
  passed to `mountMcpOAuth`), consent page at `/oauth/authorize` behind identity with a
  double-submit CSRF token, the client bound to the approving user. Revoke =
  delete the `McpClient` row (checked on every request in `mcp/verifier.ts`);
  its held calls end `+revoked` at once, its snoozes and client rules cascade.
  Unset `MCP_TOKEN` = no MCP routes at all (404).
- DCR is public, so never-approved clients (`kind OAUTH`, `userId` null) are
  pruned (`mcp/unboundClients.ts`, TC-88): before every registration and once
  at boot (index.ts), those older than `UNBOUND_CLIENT_TTL_MS` (24 h) are
  deleted, then the oldest unbound ones until at most `MAX_UNBOUND_CLIENTS`
  (100) remain including the new one. Every delete re-checks `kind OAUTH,
  userId null`, so bound and TOKEN clients are never touched. A pruned
  `client_id` is an unknown one: consent page 400 "Unbekannter oder
  abgelaufener client_id-Parameter.", token endpoint `invalid_grant` (an
  unbound client never holds a code or token anyway). Spam can evict a
  legitimate client mid-consent; it simply registers again.
- Difference from Haushalt: the resource is per upstream. The 401 challenge on
  `/mcp/<slug>` points at `/.well-known/oauth-protected-resource/mcp/<slug>`
  (`resource` = `<origin>/mcp/<slug>`); the bare well-known stays.
- `/mcp/<slug>`: the bearer (OAuth blob or `xitl_` token, see below) is verified first (401 before any slug lookup, so an
  unauthenticated caller learns nothing about slugs); then the slug is looked up
  **only among the token user's upstreams** (`userId_slug`), else 404.
  `mcp/mount.ts` keeps Haushalt's `isAuthInfo` duck-typing guard (an auth bypass
  fix: `@hono/node-server` swaps the global `Response`, so `instanceof Response`
  on the SDK's 401 is false).
- `buildMcpServer(ctx)` reads `{ userId, mcpClientId, clientName, upstream,
  wantsInstructions }` from `authInfo.extra` (user and client from
  `verifier.ts`, upstream and the peek from `mount.ts`).

### Access tokens (ADR-0015, ADR-0018, TC-50…54, TC-69…72)

- A token is an `McpClient` with `kind = TOKEN`: `userId` set at creation and a
  scope: one upstream (`allUpstreams = false`, `upstreamId` set, cascades with
  the upstream) or all upstreams (`allUpstreams = true`, `upstreamId` null;
  `POST /api/mcp/tokens {name}`, routes/mcpTokens.ts). Both creation routes use
  `createTokenClient` (routes/mcpClients.ts), `clientId` a random opaque
  id, `redirectUris` `"[]"`, `tokenHash` (unique, hex SHA-256) and `tokenPrefix`
  (first 12 chars, `xitl_abc1234`). Generated by `lib/accessToken.ts`
  (`xitl_` + 32 `randomBytes`, base64url; pure, unit-tested).
  `POST /api/upstreams/:id/tokens {name}` (1-100 chars; foreign upstream 404;
  Sec-Fetch guard as for every `/api` write) answers 201 `{client, token}`: the
  only place the token ever appears. The list (`GET /api/mcp/clients`) adds
  `kind`, `upstream {id, slug, name}`, `tokenPrefix`, `lastUsedAt`; it never
  returns hash, `clientId` or `userId`. Revoke = the existing DELETE (cancels
  held calls); no expiry.
- Gate (`mcp/mount.ts` + `mcp/verifier.ts`, `makeGateVerifier`): per request,
  a bearer starting with `xitl_` goes ONLY to `verifyAccessToken(token, slug|null)`,
  anything else ONLY to the OAuth verifier, on `/mcp/<slug>` and `/mcp` alike.
  The token path: hash -> `findUnique({tokenHash})` -> require `kind = TOKEN`,
  `userId` set and a consistent scope (all ⇔ `upstreamId` null) -> all: accepted
  for any endpoint (mount.ts still resolves the slug among the user's
  upstreams); one: endpoint must be a slug, and the upstream found by
  `(row.userId, slug)` must have `id = row.upstreamId`. Any miss is
  the same `InvalidToken` -> 401 + the OAuth challenge (no slug/token oracle).
  Success builds the same `AuthInfo.extra` (`userId`, `mcpClientId`, `clientName`);
  `mount.ts` then resolves `upstream` as for OAuth. `lastUsedAt` is bumped with a
  conditional UPDATE at most once a minute. A URL carries no user: slugs are per
  user, so the token's owner decides, never the path.
- OAuth paths ignore TOKEN rows: `/oauth/authorize` (GET/POST, incl. the binding
  UPDATE), both grants of `/mcp/token` and the OAuth verifier all filter
  `kind = OAUTH`; DCR sets `kind: 'OAUTH'` explicitly and reads no other field.
- UI: `Settings.svelte` "Token erstellen" per upstream and on the "Alle
  Upstreams" card -> `lib/TokenSheet.svelte` (`upstream` null = all)
  (name, then the token once with copy buttons and a `claude mcp add` example).

### Fake upstream (e2e)

`e2e/support/fakeUpstream.ts` on :3210, per tenant `/t/<tenant>/…`: OAuth AS
(PRM, AS metadata, DCR, auto-approving authorize with PKCE S256, token +
rotating refresh, configurable TTL, refresh rejection), a hand-rolled
Streamable-HTTP MCP server (JSON responses; bearer or `X-Fake-Key`), tools
`list_items`/`add_item`/`delete_all` (+ added ones; `leak_token` echoes its
credential), and `/control/t/<tenant>/…` (config, add or replace a tool by
name (rug pull), expire all access
tokens, state: calls, refresh count, issued tokens, registered clients).
Malicious modes per tenant (`config` `{ malice: {…} }`, type `Malice`):
`issuer`, `authorizationEndpoint`, `resource` overrides; `redirectDiscovery`
/ `redirectMcp` / `redirectToken` (307 to the sink); `asOnSink` (PRM names
an AS on the sink, TC-79); `echoInError`,
`echoInErrorResult`, `echoInList`, `echoInInstructions`; `toolCount`
(extra `bulk_<i>` tools), `padBytes` (one huge description). The **sink** is
a second listener on :3211 in the same process that answers 200 to anything
and records method, path, credential headers and body (tenant = the
`/sink/<tenant>` segment anywhere in the path). The e2e server runs with
`OUTBOUND_ALLOW_PRIVATE=127.0.0.1:3210`, so the sink is also "internal";
TC-47's redirects still prove redirect refusal because the sink is an IP
literal (the connect-time lookup never runs for literals);
`GET /control/sink/<tenant>` on :3210 lists them. Hand-rolled rather than
built on `@modelcontextprotocol/server` because that package is installed
under `apps/api/node_modules` only and e2e must not reach into a workspace.

## Target shape (from the ADRs, not built)

```
MCP client ──(OAuth bearer, ADR-0007)──▶ /mcp/<upstream>   proxy endpoint
                                            │
                     tools/call ──▶ policy engine (ADR-0004)
                                     │allow      │deny       │require_approval
                                     ▼           ▼           ▼
                                 upstream    structured   pending-call map ──(EventEmitter)──▶
                                 (stdio /    error         SSE approval UI (phase 1)
                                 HTTP/SSE,                 reviewer agent (ADR-0006)
                                 creds injected)           Web Push (phase 4, ADR-0009)
                                                           timeout 300 s ⇒ auto-deny
                     every call ──▶ audit record (ADR-0008)

Meta MCP server (ADR-0005): discovery (read) · drafts (files, never live) ·
apply_draft = CLI only.
```

Runtime data in production lives on the PVC under `/data`: the SQLite DB,
upstream YAML configs, drafts, upstream credentials. In dev: `data/` in the repo
root (gitignored) plus `apps/api/prisma/dev.db`.
