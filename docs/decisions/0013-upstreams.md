# 0013. Upstreams are web MCP servers, connected per user

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

First upstreams: Haushalt and Rezepte, then more (5–7 expected). Both siblings
accept **only OAuth** (1 h access tokens, 30 d refresh; Haushalt binds tokens to
the approving user). The briefing assumed static credentials pasted by an
admin, which would expire within an hour here. Tina should reach every upstream
too, separately from Matthias (ADR-0010).

## Decision

- **Only HTTP (Streamable HTTP) upstreams.** No stdio child processes in the
  container. A stdio server, if ever needed, gets wrapped into HTTP elsewhere
  and connected like any other (Matthias).
- **An upstream belongs to one user** (nothing shared, ADR-0010): if both want
  Haushalt, each adds it. **Each user connects it themselves**: xitl acts as an OAuth client (discovery, DCR, PKCE), the user
  consents on the upstream's own page under their identity, xitl stores and
  refreshes their tokens. A static-header credential is the fallback for an
  upstream without OAuth.
- Upstream tokens never reach an agent: not in tool output, errors or logs.

## Consequences

- xitl is OAuth server *and* client. The client side is new code, shaped by the
  sibling apps' servers, which are the test bed.
- An expired refresh token means "please reconnect" in the UI and a clear error
  to the agent, not a silent failure.
- **Rezepte for Tina:** she consents on Rezepte's page under her Authelia
  identity, so Authelia must let her into Rezepte (Matthias's side). Rezepte is
  single-user in its data model: her calls act on the same recipes and are
  attributed per client. Fine for a shared household cookbook.
- **OAuth upstreams need https** (the MCP client SDK refuses plain-http token
  endpoints except on loopback), so the siblings are reached via their **public
  URLs** (their `/mcp` and `/.well-known` are exempt from Authelia already;
  their consent page is behind it, which the user's browser passes).
- The OAuth redirect back to xitl is built from `PUBLIC_URL` or the forwarded
  headers: set `PUBLIC_URL` in production.

## Alternatives considered

- **Admin-pasted static tokens (briefing).** Expire in an hour with the siblings.
- **stdio upstreams in the container.** Bloats the image; Matthias's real
  candidates are all web servers.
