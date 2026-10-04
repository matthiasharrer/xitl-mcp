# 0012. MCP clients connect via OAuth copied from Haushalt, tokens bound to the user

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Claude.ai can only reach a remote MCP server via OAuth. The briefing planned an
embedded `node-oidc-provider` with resource indicators, multiple scopes and
trust tiers (ADR-0007). The meta server is gone (ADR-0011) and trust tiers are
dropped (ADR-0004), so the extra machinery has nothing to separate. Haushalt
(ADR-0006 there) already has a working MCP OAuth that binds tokens to the
Authelia user, in production.

## Decision

- **Copy and adapt Haushalt's `apps/api/src/mcp/` OAuth** (`oauthRoutes.ts`,
  `verifier.ts`, `lib/mcpOAuth.ts`): stateless signed codes/tokens, DCR, PKCE,
  1 h access / 30 d refresh, consent page at `/oauth/authorize` **behind
  Authelia**, the client bound to the approving user.
- Every proxied call therefore carries a **user** and a **client**; both feed
  the policy (ADR-0004) and the audit (ADR-0008).
- No static bearer token, ever (siblings' rule).
- The token is checked at call entry only.

## Consequences

- Ingress needs Haushalt's exemptions: `/mcp*` and `/.well-known/*` bypass
  Authelia; `/oauth/authorize` does not.
- Same code in three repos; fixes are ported by hand.

## Alternatives considered

- **`node-oidc-provider`** (ADR-0007): spec-complete, but heavier and nothing
  left that needs it. Revisit if a client demands resource indicators.
