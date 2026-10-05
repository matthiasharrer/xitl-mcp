# 0022. A failing upstream is told to the user (push, Freigaben) and noted in `/mcp`'s instructions

- **Status:** Accepted (revised 2026-10-05 before release: the `xitl-status`
  placeholder tool was built, then replaced by push + Freigaben card at
  Matthias's request)
- **Date:** 2026-10-05

## Context

ADR-0017 lets the unified `/mcp` degrade per upstream: one that fails, times out
or needs reconnecting is simply left out of `tools/list`. Matthias uses `/mcp`
daily (MG-07). When Haushalt's login expires, Claude just "has no Haushalt
tools", and only the server log knows why. The app shows `NEEDS_RECONNECT` in
Einstellungen, but nobody looks there, and it says nothing about an upstream
that is connected but failing.

The first build told the agent through a placeholder tool `xitl-status`.
Matthias didn't want an extra tool in the list. The person who can fix the
problem is the user, so the user is the one to tell: by push, and in the
Freigaben work list where open things already are.

## Decision

- **Upstream state**, one of:
  - `ok`,
  - `not-connected` (OAuth, never connected),
  - `reconnect` (`status = NEEDS_RECONNECT`),
  - `unreachable` (the last contact failed: `Upstream.lastFailureAt` is set).
- **`lastFailureAt`** (nullable column) is written by `withUpstream`, the one
  place xitl contacts an upstream:
  - It is set (Clock) when a contact fails for any reason other than the
    connection states. That covers network errors, timeouts, HTTP errors, a
    blocked address (ADR-0020), a protocol error and a token refresh that
    failed without meaning "reconnect".
  - It is cleared when a contact succeeds. Reconnect is tracked by `status`.
  - Last write wins between concurrent contacts.
  - A tool call that returns `isError` counts as a success, because the
    upstream answered.
- **Transitions are events.** `ok` → `unreachable` happens when `lastFailureAt`
  goes from null to set; that write is conditional on `lastFailureAt: null`, so
  only one of several concurrent failures counts. Anything → `reconnect` happens
  when `markNeedsReconnect` changes a row that wasn't `NEEDS_RECONNECT`. Back to
  `ok` happens when the clearing write or a successful connect/reconnect changes
  the row. Each transition emits an in-process event `{userId, upstreamId}`.
- **Push** to the owning user's subscriptions on a transition into `unreachable`
  or `reconnect`:
  - "Haushalt ist nicht erreichbar" or "Haushalt muss neu verbunden werden".
  - Tag `upstream-<id>`, so a newer notice replaces the older one. Tapping it
    opens Freigaben.
  - At most one push per upstream per hour (in memory, single replica), so a
    flapping upstream doesn't spam.
  - No push on recovery.
- **Freigaben** (the work list) shows one "Störung" card per upstream in
  `reconnect` or `unreachable`, above the held calls:
  - The card shows the upstream name, the state and since when (`lastFailureAt`
    for unreachable).
  - Actions: "Neu verbinden" (OAuth, the existing connect flow) or
    "Erneut prüfen" (the existing tools refresh, which sets or clears the
    state).
  - Cards arrive and leave live: the approval SSE stream carries an
    `upstreams` event with the user's current fault list on every transition,
    and the snapshot includes it.
  - A fault card is not an approval. It has no Erlauben/Ablehnen, no audit and
    no deadline.
- **Instructions on `/mcp`** keep one state line per upstream that isn't `ok`.
  It replaces the section body for `not-connected` and `reconnect`, and sits
  above the body for `unreachable`. At `initialize` the live contact decides;
  otherwise the stored state does. No tool is added to `tools/list`.
- **Only names and states** appear in agent text, push payloads and the SSE
  event: the upstream's display name and id, the state, and `lastFailureAt`.
  Never the error text, URL, status code or a credential (ADR-0007).
- **Einstellungen** keeps the "Nicht erreichbar" badge with its hint and
  "Erneut prüfen".
- `/mcp/<slug>` is unchanged.

## Consequences

- An upstream that had failed costs one extra write when it succeeds again. A
  healthy upstream costs nothing extra.
- The state only changes when xitl contacts the upstream. Nothing probes in the
  background, so a recovered upstream stays a "Störung" until the next contact
  (Claude's next `tools/list`, or "Erneut prüfen"). An upstream that breaks
  while nobody uses it is noticed at the next use.
- The agent still gets no tools from a failing upstream and isn't told why,
  apart from the instructions line. The user is told instead.
- A tool call that times out (120 s) counts as a failure and can raise a push.

## Alternatives considered

- **Placeholder tool `xitl-status` in `tools/list`** (built first): an extra
  tool in every list while something fails. Rejected by Matthias.
- **A JSON-RPC error for the whole `tools/list`:** one broken upstream would
  hide all the others (ADR-0017 degrade).
- **Background health probing:** it adds traffic and a timer, and the
  contact-driven state is enough for a household. Revisit if failures are
  noticed too late.
- **A fault as an approval-type entry in the ApprovalHub:** the hub is for
  held calls with deadlines and decisions. A separate list on the same stream
  keeps both simple.
