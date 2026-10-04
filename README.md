# xitl — X in the Loop

An MCP proxy between MCP clients (Claude.ai, Claude Code, own agents) and
upstream MCP servers. Every tool call is checked against a policy and allowed,
denied, or held for approval on the reviewer's phone.

Self-hosted, personal use. See [`docs/vision.md`](docs/vision.md) and
[`CLAUDE.md`](CLAUDE.md).

```bash
npm install && npm run db:generate && npm run db:migrate
scripts/app.sh start     # API :3002, web :5175
npm run test:unit && npm run e2e
```
