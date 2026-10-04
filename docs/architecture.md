# Architecture

> How the system fits together **right now**. Target design lives in the ADRs;
> this file describes what exists. _Last updated: 2026-10-04 (upstream registry,
> inbound MCP OAuth)._

## Current state: registry and inbound OAuth, no proxy yet

Copied and adapted from `haushalts-todos` (ADR-0002, ADR-0012):

```
apps/api/   Hono on Node 22, Prisma 7 + SQLite (better-sqlite3 adapter, WAL).
            In production also serves the built SPA (static.ts, WEB_DIST).
  /api/health            no identity
  /api/*                 behind identity.ts (Authelia Remote-User -> User row)
    /api/me
    /api/upstreams       routes/upstreams.ts: CRUD of the caller's upstreams
    /api/mcp/config      { configured } (is MCP_TOKEN set)
    /api/mcp/clients     routes/mcpClients.ts: list/rename/revoke own clients
  /mcp/register, /mcp/token, /oauth/authorize, /.well-known/*
                         mcp/oauthRoutes.ts: DCR, PKCE, consent page
  /mcp/<slug>            mcp/mount.ts: bearer gate -> slug resolved among the
                         token user's upstreams -> mcp/server.ts (STUB)
  /mcp                   404 (aggregated endpoint comes with the 2nd upstream)
  lib/clock.ts           injectable Clock (ADR-0003)
  lib/mcpOAuth.ts        signed-blob codes/tokens (HMAC with MCP_TOKEN), PKCE
  lib/externalOrigin.ts  the one definition of "our public origin"
  lib/slugs.ts           slug pattern + reserved words (register, token)
apps/web/   Svelte 5 SPA (Vite), German UI, mobile-first. Two views in the URL
            hash: Start (greeting) and Einstellungen (#/einstellungen) with
            "Upstreams" (list, add/edit sheet, delete with confirm, endpoint URL
            + copy button) and "MCP-Clients" (list, rename, revoke with confirm).
e2e/        Playwright against the built server on :3202 with .e2e/e2e.db
            (MCP_TOKEN set in e2e/support/paths.ts). TC-01...TC-14.
```

### Upstream registry (ADR-0010, ADR-0013)

- Every query is scoped by `userId`; someone else's row is a 404, like a
  missing one. Responses go through the single `serializeUpstream` whitelist
  (routes/upstreams.ts): never a spread of the row. `headerValue` is write-only
  (the API only says `hasHeaderValue`), tokens/OAuth client/pending auth never
  leave the server.
- Changing an upstream's `url` or `auth` resets it to `NOT_CONNECTED` and drops
  stored tokens and OAuth registration (tokens must not follow to another
  server). Switching away from `HEADER` clears the header.
- Slugs: `^[a-z0-9][a-z0-9-]{0,31}$`, unique per user, `register` and `token`
  reserved (they are OAuth endpoints under `/mcp`).
- Status is only displayed: there is no connect flow to upstreams yet, so every
  upstream stays `NOT_CONNECTED`.

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
- `mcp/server.ts` is a stub: serverInfo `xitl/<slug>`, instructions = the
  upstream's description or name, `tools/list` empty. `buildMcpServer(ctx)`
  reads `{ userId, mcpClientId, clientName, upstream }` from `authInfo.extra`
  (user and client from `verifier.ts`, upstream from `mount.ts`), which the
  proxy core will need. The proxy core replaces the stub.

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
