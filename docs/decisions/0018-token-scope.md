# 0018. Access tokens have a scope: one upstream or all upstreams

- **Status:** Accepted (amends ADR-0015 and the auth part of ADR-0017)
- **Date:** 2026-10-05

## Context

ADR-0017 made `/mcp` OAuth-only because per-upstream tokens (ADR-0015) are
bound to one upstream. Matthias wants every auth method on every endpoint
("all kinds of auth for all kinds of downstream"). The real difference of a
token for everything is reach: a leaked one exposes every upstream, including
ones added later, and it never expires. Policy and approvals still apply to it.

## Decision

- A TOKEN client has a **scope chosen at creation**: one upstream (as before,
  `upstreamId` set) or **all upstreams** (`allUpstreams = true`,
  `upstreamId = null`). Both are checked: a row with any other combination is
  rejected, so an upstream id lost by accident never widens a token.
- An all-upstreams token works on `/mcp` and on every `/mcp/<slug>` of its
  user (the slug is still resolved among that user's upstreams only). A
  one-upstream token works on its `/mcp/<slug>` only, never on `/mcp`.
- Created in Einstellungen on the "Alle Upstreams" card
  (`POST /api/mcp/tokens`); the client list shows "Token für alle Upstreams",
  so the wide ones are visible. Everything else as ADR-0015: shown once,
  SHA-256 stored, revocable, `xitl_` prefix, same 401 on any mismatch.
- OAuth stays valid on every endpoint. So: every endpoint takes every method.

## Consequences

- One token kind, two scopes; no second credential concept.
- An all-upstreams token silently gains upstreams added later. Accepted; the
  scope is visible in the list and revocation is one tap.

## Alternatives considered

- **A selection of upstreams per token:** more UI for little gain at 5–7
  upstreams; the two scopes cover the cases asked for.
