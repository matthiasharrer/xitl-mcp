# 0024. An access (MCP client) can be paused and resumed

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Matthias wants to switch off an access for a while without losing it: a token
pasted into a browser UI, or a Claude.ai connector he doesn't want acting
right now. Revoking (ADR-0015, DELETE) is final. A revoked token is gone, and
a revoked OAuth connector needs a new consent. Its per-client rules and
snoozes go with it.

## Decision

- **`McpClient.pausedAt`** (nullable, Clock). Paused means set. Offered on
  every client the user owns, TOKEN and OAuth alike.
- **`PATCH /api/mcp/clients/:id { paused: true | false }`**. It can be
  combined with `name` / `allowedOrigins`. The response carries `pausedAt`
  (ISO or null).
  - Pausing an already paused client keeps the first `pausedAt`.
  - Resuming sets it back to null.
  - Another user's client gets a 404, as before.
- **The gate refuses a paused client.**
  - In `mcp/mount.ts` (order of ADR-0023), the pause check runs right after
    the origin check, on the same fresh client row.
  - The refusal is `403 {"error":"access_paused","message":"Zugang pausiert. / Access paused."}`
    for every method, sessions and `DELETE` included.
  - Nothing else happens: no server is built, nothing is audited, no session
    is touched, no upstream is contacted and `lastUsedAt` is not bumped.
  - It is a 403, never a 401. A 401 would make Claude.ai start a new OAuth
    flow, and a paused access should simply wait.
- **CORS on the 403:** when the request's `Origin` passed the origin check
  (a TOKEN client listing it), the 403 carries the normal CORS headers, so a
  browser UI can show "access paused". An origin that isn't allowed gets
  `origin_not_allowed` first, as before.
- **Held calls:** pausing settles the client's held calls as denied, with
  decisionPath `…+paused`. The agent gets "Der Zugang wurde pausiert" and the
  open notification is replaced (the same "resolved" push as a revoke).
  - The re-check after an approval (the race between evaluation and `hold()`,
    the same as with a revoke) also refuses a paused client, with `+paused`.
- **Kept while paused:** the client row and its token or OAuth binding, its
  per-client rules, its snoozes, its sessions and its audit history.
  - Resuming restores everything at once.
  - A snooze keeps running down while paused. It is not extended.
- **OAuth refresh while paused:** `/mcp/token` still mints new tokens for a
  paused OAuth client.
  - The gate refuses to use them, so nothing is gained.
  - The connector keeps a valid grant, so resuming works without a new
    consent.

## Consequences

- A paused access costs nothing. It is still listed with a "pausiert" chip.
- A call already past the gate when the pause lands runs to completion. That
  is the same window as a revoke: an allowed call may still reach the upstream.
  A held call is settled denied.
- Clients see a 403 for a while. Claude.ai's behaviour on a 403 from an MCP
  server is unmeasured. At worst it shows an error until the access is
  resumed.

## Alternatives considered

- **Revoke and recreate:** loses the client's rules and snoozes, needs a new
  token or consent, and for a token in a browser UI it means pasting again.
- **Answer 401:** clients would start re-authenticating. For OAuth that means
  a consent page Matthias has to approve again, which is the opposite of
  "pause".
- **Paused = every call denied by policy (still listing tools):** the agent
  would keep trying, every call would leave an audit row, and a paused access
  should not contact upstreams at all, not even for `tools/list`.
- **Refuse token refresh while paused:** the connector would lose its grant
  and need a new consent on resume. The gate is the one place that decides.
