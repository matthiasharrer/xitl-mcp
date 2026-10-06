# 0027. xitl is never its own upstream

- **Status:** Accepted (2026-10-06, Matthias: "ja bau den check ein")
- **Date:** 2026-10-06

## Context

Matthias added Rezepte a second time (`rezepte-arbeit`, own default policy,
per ideas.md "Different policy per client") but entered xitl's own
`/mcp/rezepte` as its URL. The chain `xitl rezepte-arbeit -> xitl rezepte ->
rezepte` worked, so nothing looked wrong: xitl registered at *itself* (DCR
"xitl"), the consent he named was xitl's own, Rezepte never saw a new
registration, every call went through two policies (possibly two approvals).
Deleting that self-registration under Zugriffe then made "Neu verbinden" fail
with "Unbekannter oder abgelaufener client_id-Parameter" (the stored DCR
client_id was gone). A slug pointing at itself (`/mcp/<own slug>`) would
recurse without end.

## Decision

Two halves (`apps/api/src/lib/selfLoop.ts`):

1. **Save time (UX):** upstream create, and PATCH with a changed URL, refuse a
   URL on xitl's own external origin (`externalOrigin(c)`, scheme + host +
   port) with 400 `{ error, code: "own_address" }` (German, shown by the form's
   generic error path). Checked before the internal-address check.
2. **Request time (enforcement):** every request xitl sends to an upstream (MCP
   in `withUpstream`'s fetch, all OAuth calls via `oauthFetchFor`) carries
   `X-Xitl-Instance: <random per-process id>`, set last so a configured header
   of that name can't replace it. A middleware on `/mcp`, `/mcp/*`, `/oauth/*`
   and `/.well-known/*` answers **508 `loop_detected`** to a request carrying
   our own id, before auth, consent or DCR. This catches every alias the save
   check can't see (cluster service name, IP, another hostname).

## Consequences

- Existing self-chains (rows saved before this) stop working at once (508 →
  upstream error); the fix is to edit the URL to the real server.
- Chaining to a *different* xitl instance still works (different id).
- Every upstream sees the header: a random, per-process, non-secret value.
  Forging it can only make xitl refuse a request.
- Per process suffices: single replica (ADR-0002), the loop runs within it.

## Alternatives considered

- **Save-time check only:** misses aliases, leaves the recursion possible.
- **Hop counter allowing N hops:** no use case for xitl-through-itself.
- **Persisted instance id:** unnecessary; a restart breaks no loop detection.
