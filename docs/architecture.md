# Architecture

> How the system fits together **right now**. Target design lives in the ADRs;
> this file describes what exists. _Last updated: 2026-10-04 (scaffold)._

## Current state: scaffold only

Copied and adapted from `haushalts-todos` (ADR-0002):

```
apps/api/   Hono on Node 22. /api/health (no identity), /api/me (Authelia
            identity → User row). Prisma 7 + SQLite via better-sqlite3 adapter,
            WAL. In production also serves the built SPA (static.ts, WEB_DIST).
            lib/clock.ts: the injectable Clock (ADR-0003).
apps/web/   Svelte 5 SPA (Vite), German UI, mobile-first. Greets the user; no
            approval UI yet.
e2e/        Playwright against the built server on :3202 with .e2e/e2e.db.
```

Nothing of the proxy exists yet. Phase 1 is next (`roadmap.md`).

## Target shape (from the ADRs, not built)

```
MCP client ──(OAuth bearer, ADR-0007)──▶ /mcp/<upstream>   proxy endpoint
                                            │
                     tools/call ──▶ policy engine (ADR-0004)
                                     │allow      │deny       │require_approval
                                     ▼           ▼           ▼
                                 upstream    structured   pending-call map ──(EventEmitter)──▶
                                 (stdio /    error         SSE approval UI (phase 1)
                                 HTTP/SSE,                 reviewer agent (ADR-0006)
                                 creds injected)           Web Push (phase 4, ADR-0009)
                                                           timeout 300 s ⇒ auto-deny
                     every call ──▶ audit record (ADR-0008)

Meta MCP server (ADR-0005): discovery (read) · drafts (files, never live) ·
apply_draft = CLI only.
```

Runtime data in production lives on the PVC under `/data`: the SQLite DB,
upstream YAML configs, drafts, upstream credentials. In dev: `data/` in the repo
root (gitignored) plus `apps/api/prisma/dev.db`.
