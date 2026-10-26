# xitl — the MCP proxy, its approval UI and API in a single container.
#
# The Hono server serves both the API and the built Svelte SPA (with an
# index.html fallback for client-side routes), so there is one process, one
# port and no nginx sidecar.
#
# The runtime image is distroless (ADR-0039): Node, glibc, libstdc++ and
# OpenSSL, nothing else — no shell, no apt, no npm, no perl. That removes most
# of what Trivy used to flag. glibc-based (not Alpine) on purpose: Prisma's
# schema engine and better-sqlite3 are built against glibc.
#
# All Debian stages are pinned to bookworm so the native modules they compile
# link against the same glibc/OpenSSL as distroless's debian12.

# ---------------------------------------------------------------------------
# Stage 1 — build the SPA and compile the API to plain JS.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy only the manifests first so `npm ci` is cached until a dependency
# actually changes — the source below churns far more often than these do.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# better-sqlite3 (Prisma 7's SQLite driver adapter) is a native
# module: `npm ci` runs its `prebuild-install || node-gyp rebuild` install
# script, which fetches a prebuilt binary when it can and compiles from source
# otherwise. node:22-slim has no toolchain, so an unfetchable prebuild (a
# transient error, or GitHub's anonymous rate-limit) would drop to a compile
# that fails. Ship the toolchain so the fallback always works. This stage is
# discarded, so it costs nothing in the final image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm ci

COPY . .

# The Prisma client has to be generated before tsc: the API's types come from it.
# Prisma 7 reads apps/api/prisma.config.ts, whose datasource url is env("DATABASE_URL")
# and is resolved eagerly at config load — so `generate` (which never connects)
# still needs *some* value. Give it a throwaway; the real URL is set at runtime.
#
# No `prisma generate` in the runtime image: the `prisma-client` generator
# writes to apps/api/src/generated/prisma, tsc compiles that into
# apps/api/dist/generated/prisma, and the runtime copies dist — self-contained,
# no node_modules involvement for the generated code.
RUN DATABASE_URL=file:/tmp/build.db npx prisma generate --config apps/api/prisma.config.ts \
 && npm run build

# ---------------------------------------------------------------------------
# Stage 2 — production node_modules, installed where npm and apt exist.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

# openssl lets Prisma's postinstall detect OpenSSL 3 and fetch the matching
# schema engine (debian-openssl-3.0.x); without it, it guesses 1.1.x. The
# toolchain is better-sqlite3's compile fallback (see stage 1). This stage is
# discarded; only node_modules and the empty /data leave it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Production dependencies only. `prisma` (the CLI) is a runtime dependency
# rather than a dev one because the entrypoint applies migrations on start.
RUN npm ci --omit=dev

# Distroless has no shell to `mkdir`/`chown` with, so the mount point is made
# here and copied in with its owner. SQLite needs the *directory* writable (not
# just the file) for its -wal/-shm sidecars.
RUN mkdir -p /data && chown 1000:1000 /data

# ---------------------------------------------------------------------------
# Stage 3 — the runtime image: production deps + build output, nothing else.
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12 AS runtime

WORKDIR /app

# HOME: the Prisma CLI resolves a cache dir from os.homedir(), which throws for
# a UID without a passwd entry. PRISMA_SCHEMA_ENGINE_BINARY: don't depend on
# Prisma's platform probing (part of it shells out to `uname`/`ldconfig`,
# which don't exist here); point straight at the engine stage 2 fetched.
ENV NODE_ENV=production \
    PORT=3002 \
    DATABASE_URL=file:/data/xitl.db \
    WEB_DIST=/app/apps/web/dist \
    HOME=/tmp \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    PRISMA_SCHEMA_ENGINE_BINARY=/app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x

# The whole install tree from stage 2, not just /app/node_modules: npm puts a
# package under apps/<workspace>/node_modules when it can't hoist it (xitl
# 0.17.1 crashlooped on a nested undici that a node_modules-only copy left out).
COPY --from=deps /app ./
# The entrypoint's `prisma migrate deploy` needs the schema, the migrations
# and the datasource config, but not the generated client.
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker-entrypoint.mjs ./

COPY --from=deps /data /data
# UID 1000 (`node` in the old node:22-slim image), not distroless's `nonroot`
# (65532): the existing PVC data is owned by 1000.
USER 1000:1000

# Stamped by CI from the git tag; surfaced at /api/health.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 3002

# Exec form: there is no shell to run a string form in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/nodejs/bin/node", "/app/docker-entrypoint.mjs"]
