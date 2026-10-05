# 0023. Browser clients: allowed origins per access token (CORS on `/mcp*`)

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Matthias wants to use xitl from the llama.cpp web UI. That UI is an MCP client
running in the browser: its page calls `/mcp` with `fetch`, so the browser
first sends a CORS preflight (`OPTIONS`, because of the `Authorization` header)
and then only lets the page read the answer if it carries
`Access-Control-Allow-Origin`. xitl answers no CORS today ("server-side clients
only"), so the browser blocks it.

Browser UIs like this don't do OAuth, but they take a bearer token. Access
tokens (ADR-0015/0018) are the right credential. The preflight carries no
token, so it can't be checked against one token's settings.

`/api/*` and `/oauth/*` sit behind Authelia and its cookies. CORS there would
be a real hole. `/mcp*` uses bearer tokens only, no cookies.

## Decision

- **`McpClient.allowedOrigins`**: a JSON list of origins, TOKEN clients only,
  empty by default.
  - Set when creating a token (both token routes take an optional
    `allowedOrigins`) and editable later (`PATCH /api/mcp/clients/:id`), so
    adding a browser UI doesn't need a new token.
  - OAuth clients: 400 `origins_token_only`.
- **Origin format:** `http(s)://host[:port]`, normalized with `new URL().origin`
  (lowercase host, default port dropped, one trailing `/` tolerated on input).
  - Refused with a German 400: a path, query, fragment, userinfo, a wildcard,
    `null`, any other scheme.
  - At most 10 per token, no duplicates.
  - `http://` is allowed, because local UIs like `http://localhost:8080` are
    the point.
- **CORS only on `/mcp` and `/mcp/<slug>`.** Nothing else ever gets
  `Access-Control-*` headers.
- **Preflight** (`OPTIONS` with `Origin`) is answered before the auth gate.
  - When the origin is listed by **any** token client: 204 with:
    - `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`
    - `Access-Control-Allow-Methods: GET, POST, DELETE`
    - `Access-Control-Allow-Headers: Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID`
    - `Access-Control-Max-Age: 600`
  - Otherwise: 403 without CORS headers.
  - `Access-Control-Allow-Credentials` is never sent.
  - A positive preflight grants nothing; the request itself is checked.
- **Requests carrying `Origin`:**
  - **TOKEN client listing that origin:** served normally, with
    `Access-Control-Allow-Origin: <origin>`, `Vary: Origin` and
    `Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate` added
    (SSE responses too).
  - **TOKEN client not listing it:** 403 `{error: "origin_not_allowed"}`.
    This is checked before anything else happens: no server is built, nothing
    is audited and no upstream is contacted.
  - **401** (no token or an invalid one): when the origin is listed by any
    token, the challenge carries the CORS headers too, so the UI can show
    "unauthorized" instead of a CORS error.
  - **OAuth clients: unchanged.** No CORS headers, no Origin check. Claude.ai
    and Claude Code call server-side, and whether they send `Origin` hasn't been
    measured. Origins for OAuth clients come later if a browser OAuth client
    turns up.
- Requests without `Origin` (every server-side client) are unaffected.

## Consequences

- A token with origins is meant to be pasted into a browser UI, where it lives
  in that page's storage. That is the user's choice per token. The token's
  scope (one upstream or all) and every policy and approval still apply.
- Anyone holding the token can still use it from outside a browser. The origin
  list only limits which web pages may use it from a browser. It protects
  against a page that got hold of the token, not against a stolen token.
- The preflight reveals whether some token lists an origin. That is accepted:
  it says nothing about which user or token.
- `Mcp-Session-Id` is exposed to listed origins, so browser clients can use
  sessions (ADR-0016).

## Alternatives considered

- **`Access-Control-Allow-Origin: *` on `/mcp*`:** any web page could drive a
  token that a user pasted somewhere. There would be no per-token control.
- **Global origin list (env or Einstellungen):** coarse, and any user's entry
  would open it for everyone's tokens.
- **Answer every preflight positively:** harmless for security, since the
  request is checked, but it advertises CORS to every page on the web for no
  benefit.
- **Origins on OAuth clients now:** no browser OAuth client is in use, and
  Claude.ai's `Origin` behaviour is unmeasured. A wrong guess would break the
  daily connector.
