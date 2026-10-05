# Architecture

> How the system fits together **right now**. Target design lives in the ADRs;
> this file describes what exists. _Last updated: 2026-10-05 (unified `/mcp`,
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
    /api/upstreams/:id/tools…  routes/upstreamTools.ts: policy UI API
    /api/mcp/config      { configured } (is MCP_TOKEN set)
    /api/mcp/tokens      routes/mcpTokens.ts: create an all-upstreams token
    /api/mcp/clients     routes/mcpClients.ts: list/rename/revoke own clients (OAUTH and TOKEN kind)
    /api/approvals       routes/approvals.ts: my held calls, SSE stream, decide
    /api/audit           routes/audit.ts: my call history (Verlauf)
    /api/sessions        routes/sessions.ts: my MCP sessions + diagnostics
    /api/push            routes/push.ts: VAPID key, subscriptions, test push
  /mcp/register, /mcp/token, /oauth/authorize, /.well-known/*
                         mcp/oauthRoutes.ts: DCR, PKCE, consent page
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
  lib/policy.ts          THE policy function (pure, policy.test.ts = TC-24)
  lib/limits.ts          every abuse limit in one place (TC-44/45/48)
  lib/limitedResponse.ts byte cap on upstream/AS responses (TC-48)
  lib/proxyText.ts       ask stamp, instructions prefix, agent messages,
                         audit excerpt, secret scrubber (pure, tested)
  lib/upstreamOAuth.ts   connect state, pending-auth checks, token expiry (pure)
  upstream/oauthClient.ts  xitl as OAuth CLIENT: discovery, DCR, PKCE, code
                         exchange, refresh (+ per-upstream refresh lock)
  upstream/connection.ts withUpstream(): one short-lived MCP client connection
                         per request, credentials injected by our fetch wrapper
  upstream/tools.ts      KnownTool sync from tools/list
  approval/pending.ts    ApprovalHub: in-memory held calls + EventEmitter
  approval/budget.ts     300 s budget, approval deadline, snooze ends,
                         push summary (pure, budget.test.ts)
  approval/snooze.ts     Snooze rows (user-scoped queries)
  approval/notify.ts     hub -> Web Push (approval / resolved messages)
  approval/message.ts    the approval push payload (pure)
  lib/push.ts            Web Push sender, VAPID (AppSetting "vapid"),
                         PUSH_OUTBOX transport (copied from Haushalt)
  lib/clock.ts           injectable Clock (ADR-0003)
  lib/mcpOAuth.ts        signed-blob codes/tokens (HMAC with MCP_TOKEN), PKCE
  lib/externalOrigin.ts  the one definition of "our public origin"
  lib/slugs.ts           slug pattern + reserved words (register, token)
apps/web/   Svelte 5 SPA (Vite), German UI, mobile-first, installable PWA
            (manifest + icons + public/sw.js, push only). Tab bar:
            Freigaben (#/, live list of held calls; #/freigabe/<id> one call,
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
            TC-01…TC-68 (TC-37 unit; malicious suite in
            malicious-client.spec.ts / malicious-upstream.spec.ts). The
            server runs with APPROVAL_TIMEOUT_MS=5000 and PUSH_OUTBOX.
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
  calls as denied (`+revoked`: never forwarded to the new server); a `url`
  change also resets every KnownTool's `acknowledgedAt` (all tools "Neu"
  again, not "Geändert": explicit tool/client ALLOW rules keep applying).
  Tool policies and client overrides are kept. A HEADER upstream keeps its
  header value across a `url` change (user-initiated).
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
  the cap), runs `fn`, closes. It stores the upstream's instructions in
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
- `tools/call`: KnownTool + client override + upstream default + live snooze
  read fresh -> `evaluatePolicy` -> AuditEntry `PENDING` written first (full
  arguments, `receivedAt` via Clock, endpoint, `approvalId` for ASK) -> DENY:
  `isError` (German + English), `DENIED`; ALLOW (rule or `snooze`): forwarded,
  result returned unchanged except that our own upstream credentials are
  scrubbed if the upstream echoes them (`scrubSecrets`), audit `FORWARDED` +
  `isError` + `resultText` (≤ 2000 chars), failure -> `UPSTREAM_ERROR`,
  generic message; ASK: held (next section). `forward()` in server.ts is the
  only place a call leaves xitl.
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
  rejected one is left out (logged in `listFor`). Names via
  `unifiedName(slug, tool)`; a name breaking `^[A-Za-z0-9_.-]{1,128}$` is
  skipped with a log line.
- `tools/call`: `splitUnifiedName` (first `_`; slug must pass `isUpstreamSlug`)
  -> `upstream.findUnique({userId_slug})` -> `callTool` with the upstream's own
  tool name and `endpoint: '/mcp'`. No split / no such upstream ->
  `denyUnresolved`: audit row `DENY`/`unknown-tool`/`DENIED` with
  `upstreamId: null` and the full name, nothing contacted.
- `initialize`: `unifiedInstructions` = prefix line + naming rule + one
  section per upstream (`## <name> — Tools \`<slug>_…\``, description, own
  instructions ≤ 4 000 chars; unusable: a one-line note). Live fetch from every
  usable upstream in parallel (10 s each), else stored.
- Sessions: `McpSession.upstreamId` is null for `/mcp`; `findOwnSession`
  matches `upstreamId` exactly, so the two kinds never match each other.
  UI shows "Alle Upstreams".

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
- No CORS on `/mcp*` (server-side clients only), so no
  `Access-Control-Expose-Headers: Mcp-Session-Id` either.
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
  asked); deny -> `DENIED` `+denied:page|push`, agent text names the user;
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
  `snapshot` on connect, then `pending` / `resolved` for the caller's calls
  only; keepalive comment every 25 s; ends on shutdown; at most
  `MAX_APPROVAL_STREAMS_PER_USER` (5) open per user, the next -> 429, counted
  per route instance and released in the stream callback's finally), `GET /:id` (pending,
  or `{state:'resolved', outcome, decisionPath, …}` from the audit row by
  `approvalId`), `POST /:id` `{decision, via:'page'|'push', snoozeMinutes? |
  snoozeUntilMidnight?}` (strict zod; 404 unknown/foreign id, 409 "Diese
  Freigabe ist nicht mehr offen." when the audit row is the caller's; snooze
  on deny or on a non-snoozable call -> 400). The Sec-Fetch-Site guard
  applies (the service worker's fetch is same-origin).
- The MCP response for a held call: the SDK's legacy (2025-06-18) stateless
  leg answers over SSE and sends `: keepalive` comments every 15 s while the
  handler waits, so idle proxies see traffic.

### Snooze (ADR-0004, ADR-0019, TC-30, TC-76)

`Snooze` rows (user, upstream, client, `scope`, `toolName`, `until`). Scope
`TOOL` (toolName set), `READONLY` (every tool of the upstream whose STORED
`KnownTool.annotations` say readOnlyHint, `snooze.isReadOnly`) or `UPSTREAM`
(every tool); toolName null for the wide two. Created when an approval
carries `snoozeMinutes` (1…1440; UI: 15, 60) or `snoozeUntilMidnight` (next
00:00 Europe/Berlin, DST-safe), plus optional `snoozeScope`
(`tool`|`readonly`|`upstream`; `readonly` only for a read-only held call,
else 400; a scope without a duration is 400). server.ts narrows anything
unexpected to `TOOL`. `snooze.liveSnoozeUntil(owner, tool, readOnly, now)` /
`liveSnoozesFor(owner, now)` return the latest live covering row (pure part:
`covers`, `latestCovering`, unit-tested). `evaluatePolicy` gets that
`snoozedUntil` + `now` and upgrades **only ASK, and never for a tool awaiting
review** (`awaitingReview`: new or changed, whatever path said ASK) to ALLOW
`snooze`; DENY and unknown tools never. An annotation change marks a tool
changed, so relabelling a tool read-only can't slip under a READONLY pause.
The held call carries `snoozable` (`!awaitingReview`) and `readOnly`.
tools/list applies it too (no stamp while snoozed). A rug-pull re-flag deletes
the tool's TOOL snoozes (wide ones stay but can't apply while it awaits
review). Expired rows are pruned when a new one is written.

### Grouping (ADR-0019, TC-75)

UI only: `apps/web/src/lib/grouping.ts` (unit-tested, `npm run test:unit`
runs it with TZ=Europe/Berlin). Verlauf: day sections (Heute/Gestern/date,
browser time zone), then groups per session id, else per client id (name for
revoked clients) with ≤ 10 min between consecutive calls; sorted by
`receivedAt`, newest first. Freigaben: same groups, headers only when > 1.
`/api/audit` rows and pending approvals carry `clientId` for this.

### Rug pull (TC-36)

`syncKnownTools` compares each known tool's stored description and annotations
(annotations as canonical JSON, key order ignored) with the new list. A change
on **any** known tool (acknowledged or still "Neu": a per-client ALLOW can be
set on a "Neu" tool without acknowledging it) clears `acknowledgedAt`, sets
`changedAt` (UI "Geändert" instead of "Neu"; `isChanged` = `changedAt` set in
the tools API) and deletes its snoozes; the write is conditional on the row
still holding the old definition. Acknowledge / set policy clears `changedAt`.
`inputSchema` is not compared (not stored). **A changed tool never resolves to
ALLOW** (Matthias, 2026-10-04): an explicit tool- or client-level ALLOW
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
`session: {id, createdAt} | null` (ADR-0016). User-scoped;
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
`policy:upstream-default`; then a live snooze turns ASK into ALLOW `snooze`
unless the tool is awaiting review (new or changed). `changedAt` set counts
as changed even with `acknowledgedAt` set (fail closed). Non-Policy values
fail closed to DENY.

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
clients, plus token clients of exactly this upstream; `clients` lists the same
set): 404 otherwise.

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
  `McpClient` row, consent page at `/oauth/authorize` behind identity with a
  double-submit CSRF token, the client bound to the approving user. Revoke =
  delete the `McpClient` row (checked on every request in `mcp/verifier.ts`);
  its held calls end `+revoked` at once, its snoozes and client rules cascade.
  Unset `MCP_TOKEN` = no MCP routes at all (404).
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
/ `redirectMcp` / `redirectToken` (307 to the sink); `echoInError`,
`echoInErrorResult`, `echoInList`, `echoInInstructions`; `toolCount`
(extra `bulk_<i>` tools), `padBytes` (one huge description). The **sink** is
a second listener on :3211 in the same process that answers 200 to anything
and records method, path, credential headers and body;
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
