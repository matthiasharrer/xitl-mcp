# Architecture decision records

| #    | Decision | Status |
| ---- | -------- | ------ |
| 0001 | [Record architecture decisions](0001-record-architecture-decisions.md) | Accepted |
| 0002 | [Tech stack — same as rezepte and haushalts-todos](0002-tech-stack.md) | Accepted |
| 0003 | [Clock, LLM endpoint and push sender are injectable](0003-injectable-seams.md) | Accepted |
| 0004 | [Policy model: allow, deny or ask; auto-deny on timeout](0004-policy-model.md) | Accepted |
| 0005 | [Config as code; the meta server can draft but never apply](0005-config-as-code-and-meta-server.md) | Rejected (→ 0011) |
| 0006 | [Intent summary advises; reviewer agent decides; kept separate](0006-human-and-agent-review.md) | Summary built (→ 0025); reviewer deferred |
| 0007 | [MCP clients authenticate with OAuth; the reviewer with Authelia](0007-oauth-for-mcp-clients.md) | Superseded by 0012 |
| 0008 | [One complete audit record per call, unredacted in v1](0008-audit-trail.md) | Accepted |
| 0009 | [Approval on the phone via Web Push with actions](0009-web-push-approval.md) | Accepted |
| 0010 | [Two separate users from Authelia; nothing shared](0010-separate-users.md) | Accepted |
| 0011 | [Policies live in the database and are edited in the app](0011-policies-in-the-app.md) | Accepted |
| 0012 | [MCP clients connect via OAuth copied from Haushalt](0012-inbound-mcp-oauth.md) | Accepted |
| 0013 | [Upstreams are web MCP servers, connected per user](0013-upstreams.md) | Accepted |
| 0014 | [Upstreams reach clients two ways: one endpoint each, or all in one](0014-how-upstreams-appear-to-clients.md) | Accepted |
| 0015 | [Per-upstream access tokens as a second way for clients to authenticate](0015-per-upstream-access-tokens.md) | Accepted |
| 0016 | [MCP sessions for grouping calls, measured before designing around them](0016-mcp-sessions.md) | Accepted (step 1; Claude.ai measured: 2026-07-28, no sessions; amended: 30-day expiry) |
| 0017 | [The unified `/mcp` endpoint: names, auth, degradation](0017-unified-endpoint.md) | Accepted |
| 0018 | [Access tokens have a scope: one upstream or all upstreams](0018-token-scope.md) | Accepted |
| 0019 | [Calls grouped by day and time gaps; pauses for a tool, read-only tools or an upstream](0019-grouping-and-pause-scopes.md) | Accepted |
| 0020 | [Outbound address policy: no server-side requests to internal addresses](0020-outbound-address-policy.md) | Accepted |
| 0021 | [A URL change of an upstream resets trust](0021-upstream-url-change.md) | Accepted |
| 0022 | [A failing upstream is told to the user (push, Freigaben) and noted in `/mcp`'s instructions](0022-failing-upstream-on-unified.md) | Accepted |
| 0023 | [Browser clients: allowed origins per access token (CORS on `/mcp*`)](0023-browser-origins-per-token.md) | Accepted |
| 0024 | [An access (MCP client) can be paused and resumed](0024-pause-an-access.md) | Accepted |
| 0025 | [Intent summary from the local LLM: advisory, asynchronous, append-only context](0025-intent-summary.md) | Accepted |
| 0026 | ["Ablehnen und nicht mehr fragen": a deny pause per tool or upstream](0026-deny-pause.md) | Accepted |
