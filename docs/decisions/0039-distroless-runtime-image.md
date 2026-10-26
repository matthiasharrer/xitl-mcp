# 0039. Distroless runtime image, entrypoint in Node

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

The cluster's Trivy Operator reported, for `0.17.0`: 1 Critical, 20 High,
38 Medium, 124 Unknown. Nearly all came from `node:22-slim` (gzip, ncurses,
perl, coreutils) and the npm it bundles; undici 6.29.0 and zod 4.6.5 were the
only High findings in our own dependencies. Only the shell entrypoint needed a
shell and `npx`. haushalts-todos made the same change first (its ADR-0014; in
production 2026-10-26, Critical 4 → 1, High 21 → 6).

## Decision

- Runtime stage on **`gcr.io/distroless/nodejs22-debian12`**; production
  `node_modules` from a `node:22-bookworm-slim` stage; all Debian stages pinned
  to bookworm.
- **`docker-entrypoint.mjs`** replaces the shell script with the same
  behaviour (snapshot via better-sqlite3 `VACUUM INTO`, keep 5, fail closed;
  no snapshot while `_prisma_migrations` has a failed row; `migrate deploy`
  via `node node_modules/prisma/build/index.js`; server `import()`ed in the
  same process, so node stays PID 1).
- UID 1000 (PVC ownership), `HOME=/tmp`, `PRISMA_SCHEMA_ENGINE_BINARY` set
  explicitly. CI builds with `pull: true`.
- undici raised to 6.29.1, zod to 4.6.7.

## Consequences

- No shell in the pod: debug with `kubectl exec … -- /nodejs/bin/node -e …`
  or `kubectl debug --image=busybox --target=…`. xitl has no CLI that is run
  in the container (ADR-0005's `apply_draft` was rejected, ADR-0011), so
  nothing operational depends on a shell.
- The app starts no subprocesses and reaches upstreams over HTTP only, so
  nothing at runtime needed one either (checked: no `child_process` in
  `apps/api/src`).
- Left: OpenSSL in distroless until rebuilt upstream, mysql2/deepmerge-ts under
  the Prisma CLI.

## Alternatives considered

Same as haushalts-todos ADR-0014: npm removal only (keeps perl etc.), Alpine
(musl), Chainguard (only `latest` free).
