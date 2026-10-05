# 0015. Per-upstream access tokens as a second way for clients to authenticate

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Inbound auth is OAuth only (ADR-0012), following the siblings' rule "no static
bearer token, ever". Matthias wants clients to be able to use a **static header
with a token generated per upstream** as well: clients and automations that
don't do MCP OAuth (scripts, n8n, headless agents, Claude Code configured with
a header).

The siblings rejected a static bearer because theirs would have been **one
shared secret**: no user behind it, no per-client revoke, no attribution. Those
are the properties to keep, not the token shape.

## Decision

- A user can create **access tokens per upstream** in Settings. Each token:
  - is bound to **one user and one upstream**: valid only on `/mcp/<that slug>`
    (and later, if ever, not on the aggregated `/mcp` unless decided);
  - **is a client**: an `McpClient` row of kind `TOKEN` with a name the user
    gives ("Claude Code Laptop"), so per-client policy overrides, snoozes,
    approvals, audit attribution and revoke-cancels-held-calls all work as for
    OAuth clients;
  - is random (`xitl_` + 32 random bytes, base64url), **shown once**, stored only
    as SHA-256, with a short prefix kept for recognition;
  - is sent as `Authorization: Bearer xitl_…`;
  - can be revoked (deleting the client) at any time; `lastUsedAt` is shown.
- No expiry in v1 (revocable, visible last use). Revisit if tokens leak in
  practice.
- `MCP_TOKEN` remains only the OAuth signing secret and is never accepted.
- Policy, approval and audit don't distinguish OAuth and token clients.

## Consequences

- A leaked token gives its holder the user's access to **one** upstream, under
  that user's policy (ask still pushes to the user). That's the accepted risk.
- Tokens end up in client config files; the UI says so and offers a copyable
  config example.
- CLAUDE.md's "never a static MCP bearer token" becomes "never a *shared*
  static token; per-upstream tokens per ADR-0015 only".

## Alternatives considered

- **OAuth only (ADR-0012).** Excludes clients without MCP OAuth.
- **One token per user for all upstreams.** Larger blast radius; per upstream
  matches the per-upstream endpoints (ADR-0014).
- **A separate token table.** Duplicates every client-keyed feature; a client
  row of another kind reuses them.
