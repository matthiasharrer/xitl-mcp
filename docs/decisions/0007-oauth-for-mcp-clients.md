# 0007. MCP clients authenticate with OAuth; the reviewer with Authelia

- **Status:** **Proposed**: the identity source for the consent step is open
  (see "Open question"). Everything else is the briefing's design.
- **Date:** 2026-10-04

## Context

The proxy must be reachable by Claude.ai, which speaks MCP OAuth (protected
resource metadata, dynamic client registration, PKCE, resource indicators).
Different clients deserve different trust. The siblings put the whole app
behind Authelia except the OAuth/MCP paths, and their consent page sits behind
Authelia (Haushalt ADR-0006, rezepte ADR-0024).

## Decision (from the briefing)

- The proxy is an **OAuth2 resource server** with Protected Resource Metadata,
  **DCR, PKCE, Resource Indicators**.
- Proxy and meta server are **separate resources with separate scopes**:
  `mcp:proxy:call`, `mcp:meta:draft`, `mcp:meta:apply`.
- An **embedded authorization server** (`node-oidc-provider`).
- **Trust tiers** are assigned on the consent screen and **pinned per
  `client_id`**; the admin can create new tiers there.
- The token is checked **only at call entry**.
- **Upstream credentials** are set by the admin out of band and **injected by
  the proxy**: env vars for stdio, headers for HTTP/SSE. Agents never see or set
  them; discovery masks them. Static credentials only in v1.

## Open question: who logs in on the consent screen?

The briefing says a **hardcoded admin credential (hash)** instead of a user DB.
The sibling scheme says **no login code in the app: Authelia identifies the
person**. The two conflict.

**Recommendation:** keep `node-oidc-provider`, but have its login/consent
interaction take the user from Authelia's `Remote-User` (the consent route stays
behind Authelia, as in the siblings). No password or hash in the app, same
ingress layout as the siblings, and the OAuth protocol still comes from a
spec-complete library. Matthias decides.

## Consequences

- Ingress (GitOps repo, Matthias): `/mcp/*`, the OAuth endpoints and
  `/.well-known/*` are exempt from Authelia; UI, API and the consent route are
  not.
- Phase 2 work. Phase 1 runs the proxy without OAuth, workspace-local only.

## Alternatives considered

- **Hand-rolled stateless OAuth copied from Haushalt.** Proven here, but it
  lacks resource indicators and multiple resources; extending it means writing
  security-critical protocol code ourselves.
- **Static bearer token.** Rejected in both siblings (Haushalt ADR-0006); no
  per-client identity, so no trust tiers.
