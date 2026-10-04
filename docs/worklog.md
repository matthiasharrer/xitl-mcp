# Worklog

> One short entry **per working session**, newest first: where we left off, why,
> dead-ends, gotchas. Git covers the fine-grained "what".

## 2026-10-04 (late) — Scheduled run: changed-tool rule, malicious-client suite

- Matthias answered before the run: changed tool vs explicit allow → ask (built);
  lock-screen approve for destructive tools stays (no change, ADR-0009).
- Slice 8 by an Opus agent; six real gaps fixed (roadmap archive). Lead
  reviewed policy precedence, revoke handling and middleware order; gates
  re-run: unit 78, e2e 59.
- New question for Matthias: what an upstream URL change should do to existing
  allow rules and HEADER secrets (roadmap).
- Gotcha: an early 413 makes Node close the socket mid-upload, so Playwright
  may report "socket hang up" instead of the status; TC-44 uses a raw request.

## 2026-10-04 — Briefing review, milestone 1 built, `v0.1.0`

- Matthias reviewed the briefing (a months-old summary): two separate users
  (ADR-0010), policies in the app not YAML (0011), inbound OAuth copied from
  Haushalt (0012), HTTP upstreams connected per user via OAuth (0013), both
  per-upstream and aggregated endpoints (0014), default `allow` permitted,
  5-min auto-deny, LLM review deferred, both users on Android.
- Built in three agent batches (Sonnet: registry + inbound OAuth; Opus:
  upstream OAuth + proxy + policy; Opus: approval + push + snooze + Verlauf),
  each reviewed line by line on the security paths and re-run by the lead.
- Open questions to Matthias (roadmap): explicit ALLOW vs rug pull;
  lock-screen approve for destructive tools.
- Gotchas: `@hono/node-server` swaps global `Response`, which breaks
  `instanceof Response` in the MCP SDK twice (auth gate, OAuth error parsing);
  both worked around, see comments. MCP client SDK refuses non-https token
  endpoints → upstreams via public URLs. `migrate dev` refuses new unique
  indexes non-interactively (CLAUDE.md has the workaround). Headless Chromium
  reports notifications as denied → TC-34 stubs the browser side.

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
