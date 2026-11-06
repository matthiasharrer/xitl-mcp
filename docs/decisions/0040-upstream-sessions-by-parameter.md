# 0040. Stateful upstreams: a session handle as a tool parameter, an end tool per upstream

- **Status:** Accepted (Matthias 2026-11-06), not built yet
- **Date:** 2026-11-06

## Context

Playwright MCP (`@playwright/mcp` 0.0.83 in the cluster, `--isolated`,
`http://mcp-playwright.mcp-playwright.svc.cluster.local:8931/mcp`) is the
first **stateful** upstream. Its browser context (tabs, cookies, storage)
belongs to one Streamable-HTTP session (`Mcp-Session-Id`). Through xitl the
state was lost between calls.

**Cause (measured 2026-11-06):** `withUpstream` (upstream/connection.ts) opens a
new `Client` for every request: `initialize`, then a new upstream session, a new empty
context, then close. Through xitl in production: `browser_navigate` example.com, then
`browser_evaluate () => location.href` → `about:blank`. Locally, with real Playwright
MCP 0.0.83 behind the built server, the result was `about:blank`, the cookie set by
`httpbin.org/cookies/set?probe=1` was gone, also after an approval, while a
direct SDK client kept `https://example.com/`. The approval flow and the
unified endpoint are not involved: a held call is forwarded in the same request.

Facts that shape the fix:

- **Claude.ai and Claude Code send no session.** They speak MCP 2026-07-28
  (ADR-0016 measurements): no `initialize`, no `Mcp-Session-Id`, nothing
  stable per chat. The same problem exists without xitl
  (microsoft/playwright-mcp#1045, anthropics/claude-code#41836).
  2026-07-28 moves state into the application: the server mints a handle
  that the client passes back as an ordinary tool argument.
- **Playwright's heartbeat.** Once a client opens the standalone GET (SSE)
  stream, Playwright MCP pings it every 3 s and closes the session (and the
  browser context) when a ping goes unanswered for 5 s
  (`startHeartbeat`, playwright-core `coreBundle.js`). It only starts after a GET.
- A first draft kept one upstream session per MCP client (no parameter). It
  worked: real Playwright kept tabs and cookies across calls, approvals and 20 s idle.
  Matthias rejected it because all chats of one connector would share one
  browser, and every upstream's behaviour would change. The draft is not
  committed; its pool mechanics are reused below.

## Decision

**Opt-in per upstream.** A new switch on the upstream, „Sitzungen über
Parameter“ (`Upstream.sessionParam`, default off). Upstreams without it
behave exactly as before: one connection per request, no parameter, nothing kept.

For a marked upstream:

- **Parameter.** `tools/list` (both `/mcp/<slug>` and `/mcp`) adds an optional
  string property `xitl_session` to every tool's `inputSchema`, with a short
  description (German + English): pass the session id from the earlier answer, or
  leave it out for a new session. Added after tool sync and hashing (ADR-0031
  sees the upstream's own definition, so no false "changed" flags). An upstream
  property of the same name is never forwarded.
- **Handle.** xitl mints it: 128 random bits, base64url. It is bound to user,
  MCP client and upstream, and only looked up within that scope. It is not a
  credential; the bearer token still decides.
- **Call without `xitl_session`.** Once the call is allowed (after any
  approval), xitl opens a new upstream session, keeps it under a new handle and
  appends a text item to the result:
  „[xitl] Sitzung: <handle>. Bei weiteren Aufrufen von <Upstream> als `xitl_session` mitgeben. / Session …“.
  A denied call opens nothing.
- **Call with `xitl_session`.** The parameter is removed from the arguments
  before forwarding, and the call runs in that handle's kept upstream session.
  **Unknown, foreign or ended handle:** a new session under a new handle, with
  a notice that earlier state is gone. Unknown and foreign get the same answer,
  so nothing is revealed about other sessions.
- **End tool.** In Regeln, a tool of a marked upstream can be switched to
  „Beendet die Sitzung“ (`KnownTool.endsSession`, e.g. `browser_close`). After
  that tool's forwarded call **succeeds** (not `isError`), xitl ends the
  upstream session (DELETE) and invalidates the handle, and the answer says
  so. Denied or failed calls end nothing.
- **No start tool, no end tool of xitl's own.** xitl adds no tools, so no policy
  exception is needed. If agents lose handles in practice, an option
  „ohne Sitzung ablehnen“ plus a start tool is the planned follow-up.
- **Policy, audit, display.** Policy, rules, KI-Prüfung (Clef), AUTO and the
  approval card see the arguments **without** `xitl_session`. The handle is
  stored per call (`AuditEntry.upstreamSession`, the first characters shown on
  the card and in Verlauf). Grouping Verlauf by handle is an idea for later
  (ideas.md).
- **Kept connection (reused from the draft):**
  - The pool is in memory (one replica), keyed by user + upstream + handle.
  - The row is re-read per call (pause, auth state, OAuth refresh); credentials
    always come from the current row. A changed URL or auth kind drops the kept
    session without contacting it.
  - **No standalone GET stream:** the fetch wrapper answers 405 locally, to
    avoid Playwright's heartbeat.
  - Concurrent calls with one handle share the connection.
  - If the upstream lost the session (404, or 400 mentioning "session"), xitl
    opens it again once under the **same** handle, repeats the call (a 404
    comes before the call runs) and appends the notice that earlier state is
    lost. A 404 on a just-opened session is not retried.
  - Idle for 30 min → DELETE (sweep on use plus a 60 s `unref`'d timer). At most
    64 kept sessions (least recently used idle first; one in use is never
    closed). A restart of xitl drops all of them: handles become unknown, see
    above.
  - One-shot connections to a marked upstream (tools/list, instructions)
    DELETE their session before closing.
- **Diagnostics.** With `XITL_DEBUG_UPSTREAM_SESSIONS=1`, xitl logs per upstream
  request: HTTP method, JSON-RPC method, status, and the first 8 characters of
  the session id sent and received.

## Consequences

- Each chat or agent gets its own browser, as long as it carries its handle.
  Parallel chats are separate. Separate clients can never reach each other's
  handles.
- It depends on the model passing the handle along. Forgetting it gives a
  fresh browser (visible: new handle plus notice). Mixing up handles within
  one client reaches another chat's browser of the same client. That is a
  correctness risk, not a security one.
- The tool list of a marked upstream grows by one property per tool (roughly
  1–2k tokens for Playwright's ~25 tools).
- MCP Apps views calling tools of a marked upstream send no handle, so each
  call gets a new session.
- Schema: `Upstream.sessionParam`, `KnownTool.endsSession`,
  `AuditEntry.upstreamSession`. Name the migration after the latest one, with
  hand-written ADD COLUMN.

## Alternatives considered

- **One kept upstream session per MCP client, no parameter** (first draft):
  simplest, worked, but all chats of a connector share one browser and every
  upstream's behaviour changes. Rejected.
- **Explicit start tool, calls without a handle refused:** loud failures, but
  one more call (and approval) per task and a policy exception for xitl's own
  tools. Kept as the follow-up if handles get lost.
- **`--shared-browser-context` in Playwright** (home-server): no xitl change,
  but every client and agent shares one context and `browser_close` breaks it
  for all. Fallback only.
- **Key by trace id / `x-anthropic-client`:** per turn at best, and client-sent.
