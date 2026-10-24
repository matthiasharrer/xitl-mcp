# 0038. MCP Apps: an upstream's UI resources, opt-in per upstream

- **Status:** Proposed (2026-10-24; open questions for Matthias at the end)
- **Date:** 2026-10-24

## Context

2026-10-24, Matthias on Claude.ai (Android, "XITL Proxy All" = `/mcp`): "wie
viel Hauptspeicher ist auf dem Server belegt". The call went through and the
text answer arrived, but Claude.ai showed two "Verbindung zu XITL Proxy All
wird hergestellt … BETA" boxes with a spinner that never ended.

That box is **MCP Apps** (extension `io.modelcontextprotocol/ui`, spec
`modelcontextprotocol/ext-apps`, `specification/draft/apps.mdx`): a server
attaches an interactive HTML view to a tool, and the host renders it in a
sandboxed iframe in the chat.

- A tool points at its view: `_meta.ui.resourceUri: "ui://…"` (deprecated
  flat form `_meta["ui/resourceUri"]`), optionally `_meta.ui.visibility`:
  `["model"]`, `["app"]` or both (default both; `["app"]` = only the view may
  call it, the host hides it from the model).
- The host fetches the view with **`resources/read`**: `mimeType`
  `text/html;profile=mcp-app`, `text` (or base64 `blob`), and per content item
  `_meta.ui` (`csp.connectDomains|resourceDomains|frameDomains|baseUriDomains`,
  `permissions`, `domain`, `prefersBorder`). The same `_meta.ui` may sit on
  the `resources/list` entry; the content item wins. The host enforces the
  CSP (default `connect-src 'none'`) and may prefetch and cache.
- The view talks to the host over postMessage (`ui/*`), and the host forwards
  standard MCP requests from the view to **the server**: `tools/call`,
  `tools/list`, `resources/read`, logging. So a view can call tools.

Why the spinner: xitl passes the upstream's tool object through unchanged
(`listFor`, `{ ...t, description }`), so `_meta.ui.resourceUri` reaches
Claude.ai, but xitl only advertises the `tools` capability (`mcp/server.ts`,
"resources and prompts are not proxied (yet)"). Claude.ai's `resources/read`
fails and the box never loads. xitl promises a view it cannot deliver.

Forces:

- **The view is upstream-supplied HTML/JS**, untrusted by our threat model,
  same as tool output. Claude.ai sandboxes it; xitl does not sanitise HTML
  and should not try.
- **Every tool call a view makes still comes to xitl as `tools/call`**, so
  policy, approval, audit and pauses apply. That must stay true. Whether
  Claude.ai marks a view-initiated call (a `_meta` key, a header) is unknown;
  `metaKeys`/`headerNames` diagnostics (ADR-0016) will show it.
- **`/mcp` is one server to the host.** The spec's "views only call their own
  server's tools" then means "any tool of any upstream behind `/mcp`": a
  Home Assistant view could call `rezepte_*`. Policy still gates each call,
  but an ALLOW tool of another upstream is reachable, and its result reaches
  the view, which may send it to its declared `connectDomains`.
- A `ui://` URI is only unique within one upstream; on `/mcp` two upstreams
  may use the same one.
- The HTML can change without the tool definition changing (no rug-pull
  detection covers it today, ADR-0031).
- Matthias prefers opt-in over friction for new capabilities.

## Decision

1. **Opt-in per upstream: "Oberflächen anzeigen (MCP Apps)", default off.**
   New column `Upstream.appsEnabled Boolean @default(false)`, set only through
   `/api` (Remote-User), on the upstream's page in Einstellungen. The
   built-in `xitl` upstream (ADR-0037) has none and the switch is not shown.

2. **Off (the default): strip.** `listFor` removes `_meta.ui` and
   `_meta["ui/resourceUri"]` from every tool (other `_meta` keys pass as
   today). A tool whose `visibility` excludes `"model"` (`["app"]`) is **not
   listed at all** when off: without a view nothing legitimate calls it, and
   listing it would show the model a tool the upstream meant to hide. This
   alone ends the spinner. Ships first, before anything else here.

3. **On: pass through and serve.**
   - `tools/list` keeps `_meta.ui`. On `/mcp` the URI is rewritten to
     `ui://<slug>/<original without "ui://">` (both forms of the key); on
     `/mcp/<slug>` it stays as is. App-only tools are listed (the host hides
     them from the model) and stamped like any other ASK tool.
   - The server advertises `capabilities.resources: {}` (no `subscribe`, no
     `listChanged`: stateless, as with tools).
   - `resources/list` returns only the UI resources referenced by tools this
     client currently sees, from upstreams with the switch on. Non-UI
     resources stay unproxied (they would be a data channel with no policy).
   - `resources/read(uri)` resolves the URI to (upstream, original URI) and
     answers **only if** the upstream is the user's, visible to this client
     (not paused, not hidden by ADR-0032/0033), switched on, and a tool of it
     that this client may see (policy not DENY, same evaluation as `listFor`)
     references exactly that URI. The reference is read from
     `KnownTool.uiResourceUri` (new column, recorded on every sync). Anything
     else answers the same "unknown resource" error, no oracle.
   - The upstream's answer is passed through only if every content item has
     `uri` = the original URI and `mimeType` `text/html;profile=mcp-app` and
     the total is ≤ 2 MB; otherwise the same error. `_meta.ui` (CSP,
     permissions, domain) passes unchanged: the host enforces it, and xitl
     rewriting a CSP would only be guessing.
   - No approval for `resources/read`: it fetches the view, not data the
     agent chose, and holding it would break every render. Not an
     `AuditEntry` (not a call); logged with the upstream id and URI only.
   - Errors never carry upstream credentials or response bodies (ADR-0007).

4. **`_meta.ui` is part of the tool definition** for change detection
   (ADR-0031): a changed `resourceUri` or `visibility` is a "Geändert" tool
   (ASK, not cosmetic). The HTML itself is not tracked in this ADR (see
   Consequences).

5. **Every call stays a call.** View-initiated `tools/call` takes the normal
   path; nothing here adds a bypass. If Claude.ai turns out to mark them,
   the marker is diagnostics only (shown "aus der Oberfläche" on the card at
   most), never authority: the agent controls the same channel.

## Consequences

- Slice 1 (strip, item 2) fixes the spinner on its own and is releasable.
- Matthias decides per upstream whether its views are worth it. On `/mcp` a
  switched-on upstream's view can reach other upstreams' tools through the
  host (gated by policy); the switch's help text says so.
- New schema: `Upstream.appsEnabled`, `KnownTool.uiResourceUri`
  (hand-written `ADD COLUMN`, migration named after the latest one).
- Not covered: a changed view HTML is not flagged. Later option (ideas.md):
  store a hash per `uiResourceUri` on first read, mark "Oberfläche geändert"
  on change, advisory like the review hint.
- No `notifications/resources/list_changed`, no prompts, no non-UI resources.
- Protocol 2026-07-28 (sessionless, `_meta` envelope) needs nothing extra:
  `resources/*` are ordinary requests.
- Tests: TC cases for strip/off, URI rewrite + reverse, every refusal path of
  `resources/read` (other user, paused, hidden, DENY tool, switch off,
  unreferenced URI, wrong mimeType, oversize), and that a view-initiated
  call is still held. Manual gate on the phone: the view renders in Claude.ai.

## Alternatives considered

- **Always pass through, no switch.** Every upstream's HTML would run in his
  chats the day the upstream adds it, and reach other upstreams on `/mcp`.
  Against opt-in and fail-closed.
- **Only on `/mcp/<slug>`, never on `/mcp`.** Removes the cross-upstream
  reach, but Matthias uses "XITL Proxy All"; it would mean the feature
  doesn't exist for him. Kept as the fallback if measurement shows
  view-initiated calls bypass something.
- **Approve every `resources/read`.** Each render would need a tap; the view
  holds no agent-chosen data. Calls from the view are approved anyway.
- **Proxy all resources.** Non-UI resources are reads with agent-chosen URIs
  and no policy model; out of scope.
- **Strip forever (no MCP Apps).** Fine as slice 1; the views (charts,
  pickers) are the point of the feature, so not as the end state.

## Open questions (Matthias)

1. Opt-in per upstream, default off: ok?
2. On `/mcp` allowed (with the cross-upstream note), or only per-upstream
   endpoints?
3. View HTML changes: ignore for now (ideas.md), or flag in v1?
4. Which upstream sent the view (the RAM question)? Needed for the manual
   test.
