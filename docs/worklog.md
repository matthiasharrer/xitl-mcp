# Worklog

> One short entry **per working session**, newest first: where we left off, why,
> dead-ends, gotchas. Git covers the fine-grained "what".

## 2026-10-04 — Bootstrap

- Matthias brought a German briefing ("X in the Loop MCP Proxy") and asked for a
  third project on the sibling scheme. Briefing → `vision.md`, ADR-0002…0009,
  `ideas.md`, `roadmap.md`.
- Scaffold copied from haushalts-todos: Hono + Prisma 7/SQLite, Svelte 5 SPA,
  `scripts/app.sh` (3002/5175), e2e on :3202, Dockerfile, CI. Only `/api/health`,
  `/api/me` and a greeting page exist.
- Conflicts with the sibling scheme, taken to Matthias: consent-screen identity
  (ADR-0007, Proposed); auto-deny vs queue/resume (ADR-0004 follows the design
  doc). The briefing's "CLAUDE.md with devcontainer" is moot: the Coder
  workspace is the dev environment.
- Gotchas: `npm install` with `vitest` in the initial manifest crashed npm 10.9
  (`Cannot read properties of null (reading 'edgesOut')`); installing it
  afterwards with `npm install -D -w @xitl/api vitest` works. Prisma 7's
  `migrate dev` doesn't generate the client: run `npm run db:generate`.
