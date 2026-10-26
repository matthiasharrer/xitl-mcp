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

- **Trap (found in production, `v0.17.1`):** copy the *whole* deps-stage
  `/app`, not just `/app/node_modules`. npm leaves packages it can't hoist in
  `apps/<workspace>/node_modules` (undici here), and the workspace's own tree
  has those folders anyway, so neither tests nor the entrypoint check against
  the dev tree can see the gap. Fixed in `v0.17.2`.

## Alternatives considered

Same as haushalts-todos ADR-0014: npm removal only (keeps perl etc.), Alpine
(musl), Chainguard (only `latest` free).

## Amendment 2026-10-26 (`v0.17.3`): own Node binary, CI smoke test

- **Base `distroless/cc-debian12` + the Node binary from `node:22-bookworm-slim`**
  (copied to the same path, `/nodejs/bin/node`). Trigger: CVE-2026-111497
  ("Node2Shell", Brotli decoder RCE), fixed in Node 22.23.4 on 2026-10-21;
  `distroless/nodejs22-debian12` still shipped 22.22.0 on 2026-10-26. cc has
  every library node, sharp, better-sqlite3 and the schema engine link
  against (checked against the image's file list). The deps stage fails the
  build on any Node below 22.23.4.
- **CI smoke test before the push:** the image is built with `load: true`,
  booted on an empty volume (first deploy, all migrations), restarted
  (snapshot path) and must answer `/api/health` both times. xitl-mcp
  `v0.17.1` crashlooped in production on a nested `node_modules` the image
  lacked; this step would have stopped it in CI.
- **`/data` owned by UID 1000 in the image itself** (copied via a staging
  parent with `--chown`). Before, `COPY /data /data` left `/data` owned by
  root: invisible in production (the PVC was already 1000's), fatal on a
  fresh volume. The smoke test found it on its first run.
