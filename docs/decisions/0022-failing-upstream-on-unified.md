# 0022. A failing upstream is visible on `/mcp` and in the app

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

ADR-0017 lets the unified `/mcp` degrade per upstream: one that fails, times out
or needs reconnecting is simply left out of `tools/list`. Matthias uses `/mcp`
daily (MG-07). When Haushalt's login expires, Claude just "has no Haushalt
tools" and can't tell him why; only the server log knows. The instructions
already mark never-connected upstreams, but say nothing about one that needs a
reconnect or is unreachable. The app shows `NEEDS_RECONNECT`, but not an
upstream that is connected and failing.

Server instructions arrive once, at `initialize`. Whether a client re-reads them
or shows them to the model at all is client-specific. A tool description is the
one channel every MCP client hands to the model.

## Decision

- **Upstream state** for the agent and the app, one of:
  - `ok`,
  - `not-connected` (OAuth, never connected),
  - `reconnect` (`status = NEEDS_RECONNECT`),
  - `unreachable` (the last contact failed: `Upstream.lastFailureAt` is set).
- **`lastFailureAt`** (new nullable column) is written by `withUpstream`, the one
  place xitl contacts an upstream:
  - It is set (Clock) when a contact fails for any reason other than the
    connection states. That covers network errors, timeouts, HTTP errors, a
    blocked address (ADR-0020), a protocol error and a token refresh that
    failed without meaning "reconnect".
  - It is cleared when a contact succeeds.
  - Reconnect is still tracked by `status` alone.
  - Last write wins between concurrent contacts.
  - A tool call that returns `isError` is a success: the upstream answered.
- **Instructions on `/mcp`** carry one state line per upstream that isn't `ok`.
  It replaces the section body for `not-connected` and `reconnect`, and sits
  above the body for `unreachable`. At `initialize` the live contact decides;
  otherwise the stored state does.
- **The placeholder tool `xitl-status`** is listed on `/mcp`, and only there,
  while at least one upstream is `reconnect` or `unreachable`:
  - Its description names those upstreams with their state and says what to
    tell the user ("in xitl neu verbinden" / "gerade nicht erreichbar").
  - Calling it returns the same text, built from the stored state. It contacts
    nothing, is not audited and needs no approval.
  - Its name has no `_`, so it can never be an upstream tool (ADR-0017 names are
    `<slug>_<tool>`).
  - When nothing is failing, a call still answers ("Zurzeit fehlen keine
    Upstreams"), not an error: a client that cached the list from before the
    recovery may call it.
  - `not-connected` alone doesn't list it: an upstream left unconnected on
    purpose would otherwise add the tool to every list.
- **Only names and states reach the agent:** the upstream's display name (set by
  the user) and a fixed German/English sentence. Never the error, the URL, a
  status code or a credential (ADR-0007).
- **The app** (Einstellungen) shows a connected upstream with `lastFailureAt` as
  "Nicht erreichbar", with a short hint and a "Erneut prüfen" button. The button
  re-lists the tools (the existing refresh), which sets or clears the state.
- `/mcp/<slug>` is unchanged. A live failure answers `tools/list` with a
  JSON-RPC error carrying the generic reconnect / unreachable text. An upstream
  already stored as `NEEDS_RECONNECT` isn't contacted and lists nothing.

## Consequences

- Every successful contact of an upstream that had failed costs one extra
  write. A healthy upstream costs nothing extra (the row is read anyway).
- The stored state can lag: an upstream that recovered stays "nicht erreichbar"
  until the next contact. The next `tools/list` on `/mcp` is such a contact.
- An agent sees a tool that isn't an upstream's. It is read-only in effect and
  carries nothing the agent didn't send or the user didn't name.
- Clients that cache the tool list for a conversation keep the placeholder until
  they re-list (no `list_changed`, as before).

## Alternatives considered

- **Instructions only:** they are fetched once per `initialize`, and not every
  client shows them to the model.
- **A JSON-RPC error for the whole `tools/list`:** one broken upstream would
  hide all the others (ADR-0017 degrade).
- **`_meta` on the list result:** clients don't pass it to the model.
- **One placeholder per failing upstream (`<slug>_…`):** it would collide with
  real tool names and be routed as a call to that upstream.
