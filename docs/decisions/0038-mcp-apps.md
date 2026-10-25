# 0038. MCP Apps: an upstream's UI resources, opt-in per upstream

- **Status:** Accepted (2026-10-25, Matthias: per tool, one tap, views on `/mcp` too, pages read when the tool list is synced)
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

1. **Two values, one tap (Matthias, 2026-10-24).** A view is shown for a tool
   only if both hold:
   - **the page is acknowledged** (per resource, since several tools may
     share one `ui://` URI): new table `UiResource` (upstreamId, uri,
     `contentHash` sha256 of the HTML as last read, `acknowledgedHash`,
     `acknowledgedAt`, `changedAt`). Unique (upstreamId, uri).
   - **the tool's display is on**: `KnownTool.uiEnabled Boolean?` (null =
     the upstream default `Upstream.appsDefault Boolean @default(false)`).
   In the UI this is **one switch "Oberfläche anzeigen" per tool**: turning
   it on also acknowledges the page's current hash. A changed page shows
   "Oberfläche geändert" on every tool using it; "Neue Version anzeigen"
   re-acknowledges and leaves the tools' switches as they were. Acknowledging
   via one tool counts for every tool sharing the page; whether those show
   it follows their own switch / the upstream default. Both values are
   written only through `/api` (Remote-User). The built-in `xitl` upstream
   (ADR-0037) has no views; nothing is shown.
   **No ASK for views:** a host may prefetch at list time, and holding a
   render is pointless; what a view *does* (tool calls) is gated by the
   tools' own rules (item 5). The switch decides what is shown, never what
   is executed.

2. **Not shown: strip.** For a tool whose view is not shown (switch off,
   page not acknowledged or changed, upstream default off), `listFor`
   removes `_meta.ui` and `_meta["ui/resourceUri"]` (other `_meta` keys pass
   as today). A tool whose `visibility` excludes `"model"` (`["app"]`) is
   **not listed at all** then: without a view nothing legitimate calls it,
   and listing it would show the model a tool the upstream meant to hide.
   Stripping alone ends the spinner and ships first.

3. **Shown: pass through and serve.**
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
     (not paused, not hidden by ADR-0032/0033) and at least one tool of it
     that this client may see (policy not DENY, same evaluation as `listFor`)
     with its view shown references exactly that URI. The reference is read
     from `KnownTool.uiResourceUri` (new column, recorded on every sync).
     Anything else answers the same "unknown resource" error, no oracle.
   - The upstream's answer is passed through only if every content item has
     `uri` = the original URI and `mimeType` `text/html;profile=mcp-app` and
     the total is ≤ 2 MB; otherwise the same error. Then the sha256 of the
     HTML is compared with `acknowledgedHash`: different → `contentHash` and
     `changedAt` are recorded, the page counts as changed (stripped from the
     next `tools/list`) and this read answers the same error. A host's cached
     older copy may still render; that copy was acknowledged. `_meta.ui` (CSP,
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
  **Built 2026-10-25** (TC-240…242): since nothing can be acknowledged yet,
  every view reference is stripped and every view-only tool dropped in
  `usableTools` (not recorded at all; slice 2 must record them again once
  views can be shown).
- Slices 2–3 (items 1–5 with the amendment below) **built 2026-10-25**
  (TC-243…251): `upstream/uiViews.ts` (pure), `upstream/uiPages.ts` (reads,
  background reader), `mcp/server.ts` (listFor, callTool, `resources/*`),
  `routes/upstreamTools.ts`, Regeln `lib/ToolUiRow.svelte`. One SDK detail:
  `@modelcontextprotocol/server` 2.3 maps a thrown -32002 to **-32602** on
  the wire (with `data.uri`, the 2026-07-28 spec's resource-not-found); the
  refusal uses `ResourceNotFoundError` with one fixed message, so the code
  the host sees is -32602, not -32002.
- Matthias decides per tool whether its view is worth it; a new or changed
  page is never shown before he tapped it. On `/mcp` a shown view can reach
  other upstreams' tools through the host (gated by policy); the switch's
  help text says so.
- **Pages are read when the tool list is synced** (Matthias 2026-10-25):
  after a successful `tools/list` from the upstream, every referenced
  `ui://` page is read in the background (same checks as item 3: mimeType,
  ≤ 2 MB; at most one read in flight per page; never awaited by the list),
  and its `contentHash` / `changedAt` updated. So "Neu: Oberfläche" appears
  in Regeln as soon as the tool does, and a changed page is stripped from
  the next `tools/list` before a host tries to render it. A read on behalf
  of a host still re-checks the hash (the HTML may change between syncs).
  A failed background read changes nothing (no hash = not shown).
- A page whose HTML changes on every upstream release needs a tap per
  release.
- New schema: table `UiResource`, `Upstream.appsDefault`,
  `KnownTool.uiResourceUri`, `KnownTool.uiEnabled` (hand-written
  `ADD COLUMN`, migration named after the latest one).
- **Data resources** (files, schemas, logs, templates) stay unproxied. They
  are model-reachable reads of agent-chosen URIs, i.e. read-only tools in
  all but name, and would need the full policy (ASK, audit, pauses): a
  separate ADR when an upstream offers some (ideas.md).
- No `notifications/resources/list_changed`, no prompts, no non-UI resources.
- Protocol 2026-07-28 (sessionless, `_meta` envelope) needs nothing extra:
  `resources/*` are ordinary requests.
- Tests: TC cases for strip/off, URI rewrite + reverse, every refusal path of
  `resources/read` (other user, paused, hidden, DENY tool, switch off,
  unreferenced URI, wrong mimeType, oversize), and that a view-initiated
  call is still held. Manual gate on the phone: the view renders in Claude.ai.

## Amendment 2026-10-25: details fixed for slices 2–3 (lead)

Refinements found while specifying; none changes what Matthias decided.

- **No upstream default.** `Upstream.appsDefault` is dropped:
  `KnownTool.uiEnabled Boolean @default(false)`. A shown view always needed
  a tap anyway (acknowledgement), so an upstream-wide default only added a
  concept. Acknowledging via tool A does not turn tool B on; B's own tap
  does (re-reads and re-acknowledges, harmless).
- **The tap reads the page now.** `PATCH …/tools/:toolId {uiEnabled:true}`
  (and "Neue Version anzeigen") reads the page from the upstream right then
  and acknowledges exactly that hash; a failed read → 502 with a German
  message, nothing changed. So what is acknowledged is what is current,
  never a hash from an older background read.
- **The hash covers the page's `_meta.ui` too:** sha256 of canonical JSON
  `{text|blob, mimeType, meta}` of the content items. A widened CSP
  (`connectDomains`) is a change that needs a new tap, like new HTML. The
  page's CSP domains and permissions are stored (clipped) and shown on the
  tool card ("Darf verbinden mit …" / "Keine externen Verbindungen").
- **Tool definition:** `KnownTool.uiMeta` = canonical JSON of `{resourceUri,
  visibility}` (or the string "null"); NULL = recorded before the column
  existed, stored silently on first sight (like `inputSchema`, ADR-0031), so
  the release doesn't flag every existing Grafana tool. A later difference
  is a change (`changedAt`, `prevUiMeta`). `uiResourceUri` is derived from
  it (only `ui://` strings ≤ 512 chars; anything else = no view).
- **View-only tools** (visibility without `"model"`) are recorded again
  (slice 1 dropped them in `usableTools`). They are listed and callable only
  while the upstream has at least one tool whose view is shown to this
  client; otherwise not listed and refused as unknown (`unknown-tool`, as in
  slice 1). Policy applies to them like to every tool.
- **Error code** of every refused `resources/read`: JSON-RPC `-32002` (on the wire `-32602`, see Consequences)
  "Resource not found", one text for all reasons (no oracle).
- **Token scope** (ADR-0018) applies to resources exactly as to tools: a
  page of an upstream outside the token's scope does not exist.

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
- **Per upstream only (first draft).** Too coarse once views are per tool,
  and no answer to changed HTML.
- **Acknowledge page and switch display separately in the UI.** Two taps for
  one intent; kept as two stored values only so a changed page can be
  blocked without losing the switches.
- **Strip forever (no MCP Apps).** Fine as slice 1; the views (charts,
  pickers) are the point of the feature, so not as the end state.

## Settled with Matthias

2026-10-24: per tool, default off; page acknowledged + display on in one
tap; changed HTML re-asked (hash); no ASK for views; data resources out of
scope. 2026-10-25: views on `/mcp` too (with the cross-upstream note); pages
read in the background on tool sync.
