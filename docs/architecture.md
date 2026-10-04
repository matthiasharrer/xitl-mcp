# Architecture

> How the system fits together **right now**. Target design lives in the ADRs;
> this file describes what exists. _Last updated: 2026-10-04 (upstream OAuth
> client, proxy core, policy engine, Regeln view)._

## Current state: proxy with allow/deny, no approval channel yet

Copied and adapted from `haushalts-todos` (ADR-0002, ADR-0012):

```
apps/api/   Hono on Node 22, Prisma 7 + SQLite (better-sqlite3 adapter, WAL).
            In production also serves the built SPA (static.ts, WEB_DIST).
  /api/health            no identity
  /api/*                 Sec-Fetch-Site guard (app.ts), then identity.ts
                         (Authelia Remote-User -> User row)
    /api/me
    /api/upstreams       routes/upstreams.ts: CRUD of the caller's upstreams,
                         POST /:id/connect, GET /oauth/callback (upstream OAuth)
    /api/upstreams/:id/tools…  routes/upstreamTools.ts: policy UI API
    /api/mcp/config      { configured } (is MCP_TOKEN set)
    /api/mcp/clients     routes/mcpClients.ts: list/rename/revoke own clients
  /mcp/register, /mcp/token, /oauth/authorize, /.well-known/*
                         mcp/oauthRoutes.ts: DCR, PKCE, consent page
  /mcp/<slug>            mcp/mount.ts: bearer gate -> slug resolved among the
                         token user's upstreams -> mcp/server.ts (proxy core)
  /mcp                   404 (aggregated endpoint comes with the 2nd upstream)
  lib/policy.ts          THE policy function (pure, policy.test.ts = TC-24)
  lib/proxyText.ts       ask stamp, instructions prefix, agent messages,
                         audit excerpt, secret scrubber (pure, tested)
  lib/upstreamOAuth.ts   connect state, pending-auth checks, token expiry (pure)
  upstream/oauthClient.ts  xitl as OAuth CLIENT: discovery, DCR, PKCE, code
                         exchange, refresh (+ per-upstream refresh lock)
  upstream/connection.ts withUpstream(): one short-lived MCP client connection
                         per request, credentials injected by our fetch wrapper
  upstream/tools.ts      KnownTool sync from tools/list
  lib/clock.ts           injectable Clock (ADR-0003)
  lib/mcpOAuth.ts        signed-blob codes/tokens (HMAC with MCP_TOKEN), PKCE
  lib/externalOrigin.ts  the one definition of "our public origin"
  lib/slugs.ts           slug pattern + reserved words (register, token)
apps/web/   Svelte 5 SPA (Vite), German UI, mobile-first. Views in the URL hash:
            Start, Einstellungen (#/einstellungen: upstreams with status,
            Verbinden/Neu verbinden, Regeln link, endpoint URL + copy; MCP
            clients) and Regeln (#/regeln/<id>, routes/Rules.svelte).
            "#/einstellungen?verbunden=<id>" / "?verbindung=…" carry the OAuth
            callback's result once (toast, then dropped from the URL).
e2e/        Playwright against the built server on :3202 with .e2e/e2e.db
            (output in .e2e/api.log) plus the fake upstream on :3210
            (e2e/support/fakeUpstream.ts). TC-01…TC-26.
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
  registration (tokens must not follow to another server); a `url` change also
  resets every KnownTool's `acknowledgedAt` (all tools "Neu" again). Tool
  policies and client overrides are kept.
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
- PRM `resource` on another origin than the upstream URL -> connect refused;
  otherwise it is sent as the RFC 8707 resource. Scope = PRM `scopes_supported`.
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
- OAuth POSTs refuse redirects; all OAuth requests time out after 15 s. The
  SDK refuses non-https token endpoints except loopback (deploy note: an
  in-cluster `http://…svc` upstream would fail to connect).
- Logs carry error class/code only (`errorTag`), never messages or bodies.

### Proxy core (ADR-0004, ADR-0008, ADR-0014, TC-19…23)

- `/mcp/<slug>` stays stateless: `createMcpHandler(buildMcpServer)`; the
  factory is async and loads the upstream + user per request. mount.ts peeks
  at the JSON-RPC method (clone, ≤ 64 KiB, declared length only) so only
  `initialize`/`server/discover` contacts the upstream for its instructions.
- Upstream access: `withUpstream(upstreamId, userId, fn)` re-reads the row
  scoped by user, opens a `Client` + `StreamableHTTPClientTransport` with our
  own `fetch` wrapper (credential only to the upstream's origin, `redirect:
  'error'`, timeout 15 s connect / 120 s call), runs `fn`, closes. It stores
  the upstream's instructions in `Upstream.instructions` when they change.
- `initialize`: instructions = prefix line ("Über xitl vermittelt … / Proxied
  by xitl …") + the upstream's instructions (live, else last seen, else the
  description, else the name). Only `tools` is advertised: **resources and
  prompts are not proxied** (out of scope for now).
- `tools/list`: not usable (OAUTH not connected / needs reconnect) -> `[]`
  without contacting the upstream; otherwise fetch, `syncKnownTools`, evaluate
  per tool for this client: DENY dropped, ASK description + stamp, ALLOW
  unchanged. Upstream failure -> JSON-RPC error with a generic message.
- `tools/call`: KnownTool + client override + upstream default read fresh ->
  `evaluatePolicy` -> AuditEntry `PENDING` written first (full arguments,
  `receivedAt` via Clock, endpoint) -> DENY: `isError` (German + English),
  `DENIED`; ASK: `DENIED`, decisionPath `<rule>+ask:no-channel` (**slice 6
  replaces this**, marked in server.ts); ALLOW: forwarded, result returned
  unchanged except that our own upstream credentials are scrubbed if the
  upstream echoes them (`scrubSecrets`), audit `FORWARDED` + `isError` +
  `resultText` (≤ 2000 chars). Failure -> `UPSTREAM_ERROR`, generic message.
- No `notifications/tools/list_changed` on policy changes: the endpoint has no
  sessions; the next `tools/list` sees the change.

### Policy engine (ADR-0004, TC-24)

`lib/policy.ts` `evaluatePolicy({ upstreamDefault, tool, clientOverride })`:
unknown tool (no KnownTool) -> DENY `unknown-tool`; client override ->
`policy:client`; tool policy -> `policy:tool`; unacknowledged -> ASK
`new-tool`; else default -> `policy:upstream-default`. Non-Policy values fail
closed to DENY. The snooze seam (slice 6) is a commented spot in the function.

KnownTool rows come from every upstream `tools/list` (proxy or "Tools
aktualisieren"). The **first** list ever seen for an upstream is recorded as
acknowledged (`ACKNOWLEDGE_INITIAL_TOOLS` in upstream/tools.ts): the new-tool
rule is for tools the upstream adds later. Any later new tool is `acknowledgedAt
= null` until the user sets a policy for it or acknowledges it.

### Policy UI API (TC-25, TC-26)

`GET /api/upstreams/:id/tools` (tools with hint from annotations —
readOnlyHint -> Lesen, destructiveHint true -> Destruktiv, else Schreiben —,
own policy, effective policy without client override, path, `isNew`, the
caller's client overrides; plus the caller's clients), `POST …/tools/refresh`,
`PATCH …/tools/:toolId` `{ policy | null }` (sets `acknowledgedAt`),
`POST …/tools/:toolId/acknowledge`, `PUT/DELETE
…/tools/:toolId/clients/:mcpClientId`. The upstream is resolved among the
caller's, the tool through that upstream, the client among the caller's: 404
otherwise.

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
  delete the `McpClient` row (checked on every request in `mcp/verifier.ts`).
  Unset `MCP_TOKEN` = no MCP routes at all (404).
- Difference from Haushalt: the resource is per upstream. The 401 challenge on
  `/mcp/<slug>` points at `/.well-known/oauth-protected-resource/mcp/<slug>`
  (`resource` = `<origin>/mcp/<slug>`); the bare well-known stays.
- `/mcp/<slug>`: the token is verified first (401 before any slug lookup, so an
  unauthenticated caller learns nothing about slugs); then the slug is looked up
  **only among the token user's upstreams** (`userId_slug`), else 404.
  `mcp/mount.ts` keeps Haushalt's `isAuthInfo` duck-typing guard (an auth bypass
  fix: `@hono/node-server` swaps the global `Response`, so `instanceof Response`
  on the SDK's 401 is false).
- `buildMcpServer(ctx)` reads `{ userId, mcpClientId, clientName, upstream,
  wantsInstructions }` from `authInfo.extra` (user and client from
  `verifier.ts`, upstream and the peek from `mount.ts`).

### Fake upstream (e2e)

`e2e/support/fakeUpstream.ts` on :3210, per tenant `/t/<tenant>/…`: OAuth AS
(PRM, AS metadata, DCR, auto-approving authorize with PKCE S256, token +
rotating refresh, configurable TTL, refresh rejection), a hand-rolled
Streamable-HTTP MCP server (JSON responses; bearer or `X-Fake-Key`), tools
`list_items`/`add_item`/`delete_all` (+ added ones; `leak_token` echoes its
credential), and `/control/t/<tenant>/…` (config, add tool, expire all access
tokens, state: calls, refresh count, issued tokens). Hand-rolled rather than
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
