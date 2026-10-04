# Architecture decision records

| #    | Decision | Status |
| ---- | -------- | ------ |
| 0001 | [Record architecture decisions](0001-record-architecture-decisions.md) | Accepted |
| 0002 | [Tech stack — same as rezepte and haushalts-todos](0002-tech-stack.md) | Accepted |
| 0003 | [Clock, LLM endpoint and push sender are injectable](0003-injectable-seams.md) | Accepted |
| 0004 | [Policy model: allow, deny or ask; auto-deny on timeout](0004-policy-model.md) | Accepted |
| 0005 | [Config as code; the meta server can draft but never apply](0005-config-as-code-and-meta-server.md) | Rejected (→ 0011) |
| 0006 | [Intent summary advises; reviewer agent decides; kept separate](0006-human-and-agent-review.md) | Deferred |
| 0007 | [MCP clients authenticate with OAuth; the reviewer with Authelia](0007-oauth-for-mcp-clients.md) | Superseded by 0012 |
| 0008 | [One complete audit record per call, unredacted in v1](0008-audit-trail.md) | Accepted |
| 0009 | [Approval on the phone via Web Push with actions](0009-web-push-approval.md) | Accepted |
| 0010 | [Two separate users from Authelia; nothing shared](0010-separate-users.md) | Accepted |
| 0011 | [Policies live in the database and are edited in the app](0011-policies-in-the-app.md) | Accepted |
| 0012 | [MCP clients connect via OAuth copied from Haushalt](0012-inbound-mcp-oauth.md) | Accepted |
| 0013 | [Upstreams are web MCP servers, connected per user](0013-upstreams.md) | Accepted |
| 0014 | [Upstreams reach clients two ways: one endpoint each, or all in one](0014-how-upstreams-appear-to-clients.md) | Accepted |
