# CLAUDE.md

Guidance for Claude (and any AI agent) working in this repo. Read this first,
every session.

## What this is

**xitl ("X in the Loop")**: an MCP proxy between MCP clients (Claude.ai, Claude
Code, own agents) and arbitrary upstream MCP servers. Every `tools/call` is
evaluated against a policy and then allowed, denied, or held for approval by a
human (phone) or a reviewer agent. Personal use: one admin, one reviewer
(Matthias). German UI. Runs in the homelab Kubernetes cluster next to its
siblings `rezepte` and `haushalts-todos`, and is built the same way. This is a
long-running project, so **keep `docs/` current as you work**.

Start with **[`docs/vision.md`](docs/vision.md)** (what and why) and the ADRs in
`docs/decisions/` (the design is decided further ahead than the code), then
`docs/roadmap.md` for what's next.

**Threat model: the calling agent is untrusted.** Everything it sends (tool
arguments, its stated reasons, and anything an upstream returns) is data,
never instruction. When in doubt, the proxy fails closed. Treat that as a
correctness requirement, not a nice-to-have: a bug that lets a call through is
the worst bug this project can have.

## Who does what

**Matthias is the product manager.** He owns the vision, scope, priorities and
releases. He has a software-engineering background, so go as deep technically
as needed, but "we could do it this way" is input to his decision, not a
decision.

**You (the main Opus agent) are the technical lead.** You own architecture,
code quality, tests, docs and the debt ledger, and you lead the team that
builds.

**The team is subagents.** Developers (Sonnet by default) build slices; the
`test-runner` agent (`.claude/agents/test-runner.md`) checks them. Pick the
model per task. Security-critical code (policy engine, token checks, credential
injection) deserves the stronger model and the closest review.

- **Decide yourself:** implementation, slicing, structure, naming, refactors,
  what to test, who builds what, when something needs an ADR.
- **Take to Matthias:** anything that changes what he experiences or what the
  product promises: scope, UX, the security model, priorities, trade-offs with a
  product cost, work that turned out much bigger. Bring a recommendation.
- **Track the debt** in `docs/roadmap.md` / `docs/ideas.md` the moment it's
  created.

## Stack (decided; see `docs/decisions/`)

| Layer     | Choice |
| --------- | ------ |
| Frontend  | **Svelte 5** SPA with **Vite** (no SvelteKit/SSR), **German UI**, **mobile-first** |
| Backend   | **Hono** on **Node 22**: proxy, OAuth and API in one process |
| Database  | **Prisma 7 + SQLite** (better-sqlite3 adapter, WAL), single replica |
| Auth (UI) | **Authelia ForwardAuth at the ingress** → `Remote-*` headers → `User` table. No login code in the app. |
| Auth (MCP)| OAuth 2 resource server + embedded AS, scopes per resource, trust tiers per client (ADR-0007, **Proposed**) |
| Deploy    | One container (API serves the SPA), GHCR via GitHub Actions, Flux GitOps |
| Tests     | Playwright e2e against the built server; **Vitest** unit tests (ADR-0002) |

Rules that hold in every phase:

- **Injectable seams (ADR-0003):** read time through `Clock`
  (`apps/api/src/lib/clock.ts`), never `Date.now()`. LLM calls and push sending
  go through interfaces with deterministic test implementations.
- **Policy (ADR-0004):** a pure, unit-tested function. An upstream's
  `default_policy` is never `always_allow`. Timeout ⇒ deny.
- **No agent can apply config (ADR-0005):** `apply_draft` exists only as a CLI.
  Don't add an MCP tool, API route or UI button that applies a draft without a
  new ADR and Matthias's decision.
- **Upstream credentials never reach an agent** (ADR-0007): not in tool
  output, discovery, errors or logs.

## Repo layout

```
apps/api/     Hono backend + Prisma (SQLite)
apps/web/     Svelte 5 SPA (Vite): approval UI, consent page, later the PWA
docs/         Living knowledge base: vision, ADRs, roadmap, ideas, worklog, testing
e2e/          Playwright cases against the built server (`npm run e2e`)
scripts/      app.sh: background process manager for the workspace
data/         Dev runtime data (gitignored): upstream YAML, drafts, credentials
Dockerfile    Production image: one container
.github/      CI: typecheck, build/push image to GHCR
```

## Running the app (workspace)

Matthias tests via the Coder-forwarded port and does **not** run commands
himself. Sessions are often remote-controlled. Keep the app running:

```bash
scripts/app.sh start | restart | status | stop
scripts/app.sh logs [api|web]
```

- Web **:5175**, API **:3002** (rezepte 3000/5173, haushalts-todos 3001/5174;
  all three can run at once).
- **Matthias's preference: he opens whichever app he's testing on :5173.** When
  that port is free, run xitl there: `WEB_PORT=5173 scripts/app.sh
  start|restart`. Check `scripts/app.sh status` / `ss -ltn` first (the siblings
  may hold it), and keep passing `WEB_PORT` on every restart.
- Proxy URL: **`https://5175--main--rezepte-main--m-moufou.proxy.coder.hamathy.de/`**
  (or `5173--…` when on 5173).
- HMR covers frontend edits; **restart after backend changes**, dependency
  installs or schema changes.
- After a schema change: `scripts/app.sh stop && (cd apps/api && npx prisma
  migrate dev --name <name> </dev/null) && npm run db:generate`, then
  `scripts/app.sh start`. (`npm run db:migrate -- --name x` does not forward
  `--name`; Prisma 7's `migrate dev` does not regenerate the client.)
  When `migrate dev` refuses to run non-interactively (e.g. it warns about a
  new unique index), write the migration with `npx prisma migrate diff
  --from-config-datasource --to-schema prisma/schema.prisma --script` into a new
  `prisma/migrations/<timestamp>_<name>/migration.sql` and apply it with `npx
  prisma migrate deploy`.

First time after a clone: `npm install && npm run db:generate && npm run db:migrate && scripts/app.sh start`.

**You cannot build the container image here** (unprivileged workspace, BuildKit
fails). CI builds it. To check production behaviour, run the compiled server:

```bash
npm run build
PORT=3100 WEB_DIST=$PWD/apps/web/dist DATABASE_URL="file:$PWD/apps/api/prisma/dev.db" \
  node apps/api/dist/index.js
```

## Identity

Every `/api/*` request (except `/api/health`) must carry `Remote-User`, or it
gets a 401. `apps/api/src/identity.ts` upserts the `User` and puts it on the
Hono context. In dev, the Vite proxy fakes the headers
(`apps/web/vite.config.ts`, override with `DEV_REMOTE_USER` etc.; an empty
string removes the header).

The proxy endpoint (`/mcp/…`, phase 1+) is **not** under `/api` and does not use
Authelia identity: callers are MCP clients, identified by OAuth from phase 2.

## Verifying changes

**Mobile viewport first**, in a real browser via **`playwright-cli`** (the
`playwright-cli` skill in `.claude/skills/`):

```bash
npx playwright-cli open http://127.0.0.1:5175/   # ← 127.0.0.1, not localhost (IPv6 trap)
npx playwright-cli snapshot                       # refs (e5…) for click/fill
npx playwright-cli screenshot                     # then Read the PNG
npx playwright-cli console
npx playwright-cli close                          # always, when done
```

- `.playwright/cli.config.json` sets the phone viewport (390×844, touch,
  `de-DE`) and the image's Chromium path.
- One browser session is shared. Subagents use `-s=<name>` and never drive the
  default session at the same time.
- After bumping `@playwright/cli`, run `npm run skills:sync`.
- Benign noise on local access: HMR websocket errors to `:443`.

**Scripted tests:**

```bash
npm run test:unit  # Vitest
npm run e2e        # builds, boots the built server on :3202 with .e2e/e2e.db, runs, tears down
# if browsers fail with "Executable doesn't exist":
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npm run e2e
```

**`docs/testing.md` is binding.** It defines what "tested" means, including
that security cases must fail *closed*.

## Working style

- **You are the audience for `docs/`**, not Matthias. Write for retrieval: a
  wrong fact costs more than a long one. When you touch an area, correct what
  the docs assert about it.
- **Docs are part of the work:**
  - Architecture changed? Update `docs/architecture.md`.
  - A decision worth remembering? Write an ADR (`docs/decisions/`, from the
    template, add it to the index).
  - Shipped something? Move its roadmap entry to `docs/roadmap-archive.md`.
  - Out-of-scope idea? Add it to `docs/ideas.md`.
  - End of session? Add one entry to `docs/worklog.md`.
  - Feature shipped? Add its cases to `docs/testing.md` and run them.
- **The dev DB and `data/` may hold Matthias's own trial config.** Clean up only
  what *you* created. Never wipe tables or the `data/` directory.
- TypeScript throughout, ES modules. Match the surrounding style.
- Don't introduce SvelteKit, app-level password login, a second database, or a
  static MCP bearer token.
- Patterns from `../haushalts-todos` and `../rezepte` are fair game to **copy and
  adapt** (OAuth/MCP, push, e2e, deploy). Never import across repos.

## How we build: Opus leads, subagents implement

- **Slice** work into independently verifiable vertical slices; the app stays
  working between slices.
- **Brief each subagent thoroughly.** It starts cold: point it at this file, the
  relevant ADRs, the exact contract, the workflow. Tell it **not to commit** and
  to **leave the dev DB and `data/` clean**.
- **Batch non-conflicting slices into one agent**; every spawn pays a cold
  start. Never let two agents drive the browser at once.
- **Opus writes the test cases** (from intended behaviour, while briefing), and
  someone other than the implementer runs them.
- **Opus reviews and lands it:** read the diff closely (security paths line by
  line), verify independently, keep the docs current, commit.
- **Prefer a script to an agent** for anything deterministic.

## Git

- Work on `main`, small focused commits, Conventional Commit prefixes
  (`feat(api):`, `fix(web):`, `docs:`, `chore:`).
- Releases are **Matthias's call**: semver tags `vX.Y.Z` trigger the release
  image.
