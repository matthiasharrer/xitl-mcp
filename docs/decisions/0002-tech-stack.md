# 0002. Tech stack — same as rezepte and haushalts-todos

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Matthias wants a third project "with the same scheme for development, release,
deployment and tech stack" as its siblings. His briefing asks for TypeScript on
Node 22, SQLite via `better-sqlite3` and a single container, which the sibling
stack already is. xitl is different in kind from the siblings: it is
infrastructure (a proxy) with a small UI, not a phone app with an MCP endpoint
on the side.

## Decision

Mirror haushalts-todos (itself a copy of rezepte):

| Layer     | Choice |
| --------- | ------ |
| Frontend  | Svelte 5 SPA with Vite (no SvelteKit/SSR), German UI, mobile-first. Holds the approval UI, the OAuth consent page and (phase 4) the PWA. |
| Backend   | Hono on Node 22; proxy, OAuth and API in one process |
| Database  | Prisma 7 + SQLite (better-sqlite3 adapter, WAL), single replica |
| Auth (UI) | Authelia ForwardAuth at the ingress; `Remote-User` → `User` table (copied from Haushalt's ADR-0003). MCP-side OAuth: ADR-0007. |
| Deploy    | One container, GHCR via GitHub Actions, Flux GitOps, `v*` tags are releases |
| Tests     | Playwright e2e against the built server; **Vitest** for unit tests (deviation, below) |

Ports in the workspace: API **3002**, web **5175**, e2e server **3202**.

**Deviation: Vitest instead of `node --test`.** The briefing names Vitest with
fake timers; timeouts (300 s) and snooze TTLs are the heart of the domain, and
Vitest's timer control is the better fit. Siblings stay on `node --test`.

Expected additions when the phases need them, each with its own ADR if
non-obvious: `@modelcontextprotocol/*` (server side towards clients, client
side towards upstreams), a YAML parser, `diff` (ADR-0005), `web-push`.

## Consequences

- Everything the siblings learned the hard way (Prisma/TS pins, the e2e
  browser trap, ingress exemptions for OAuth paths) applies directly.
- Upstreams are HTTP only (ADR-0013), so the image needs no extra runtimes.
- Code is copied, not shared: fixes in a sibling need porting by hand.

## Alternatives considered

- **No UI at all, CLI + push only.** The consent screen (ADR-0007) and the
  phase-1 approval UI need a browser anyway.
- **Raw `better-sqlite3` without Prisma**, as the briefing literally says. The
  sibling setup *is* better-sqlite3 underneath; Prisma adds migrations, the
  entrypoint snapshot and the CI schema check for free.
