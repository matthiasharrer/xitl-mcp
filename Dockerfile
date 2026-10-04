# xitl — the MCP proxy, its approval UI and API in a single container.
#
# The Hono server serves both the API and the built Svelte SPA (with an
# index.html fallback for client-side routes), so there is one process, one
# port and no nginx sidecar.
#
# Debian-based (not Alpine) on purpose: Prisma's query engine is built against
# glibc, and a musl image needs a different binaryTarget in schema.prisma.

# ---------------------------------------------------------------------------
# Stage 1 — build the SPA and compile the API to plain JS.
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

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
RUN DATABASE_URL=file:/tmp/build.db npx prisma generate --config apps/api/prisma.config.ts \
 && npm run build

# ---------------------------------------------------------------------------
# Stage 2 — the runtime image: production deps + build output, nothing else.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# openssl is needed by the Prisma CLI's migration engine, which the entrypoint
# runs on start (the query engine itself is gone in v7).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3002 \
    DATABASE_URL=file:/data/xitl.db \
    WEB_DIST=/app/apps/web/dist

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Production dependencies only. `prisma` (the CLI) is a runtime dependency
# rather than a dev one because the entrypoint applies migrations on start —
# see the entrypoint. better-sqlite3 (the SQLite driver adapter) is native:
# install a toolchain so its compile fallback works if the prebuild can't be
# fetched, then purge it in the same layer so the runtime image stays lean —
# the compiled .node binary remains and links only against libstdc++6/libc,
# which are already in the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# No `prisma generate` here (unlike the build stage) — and deliberately so.
# The old `prisma-client-js` generator wrote into node_modules/@prisma/client,
# a path this stage's own `npm ci --omit=dev` above doesn't populate (it
# doesn't run `generate`), so a runtime generate used to be required to make
# `require('@prisma/client')` resolve at all. The `prisma-client` generator
# (schema.prisma) has no such gap: it writes to the fixed, explicit path
# apps/api/src/generated/prisma, tsc compiles that into
# apps/api/dist/generated/prisma alongside the rest of the server, and that
# compiled output is already in the `COPY --from=build .../dist` line above —
# self-contained, no node_modules involvement for the generated code itself.
# Regenerating here would be a no-op at best (nothing in this stage imports
# from apps/api/src, which isn't even copied in) and silently wrong at worst
# if it ever diverged from what was actually compiled and shipped.
#
# apps/api/prisma + prisma.config.ts ARE still copied above — the entrypoint's
# `prisma migrate deploy` / `prisma db execute` (docker-entrypoint.sh) need
# the schema and datasource config, but not the generated client.

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The DB lives on the mounted volume. SQLite needs the *directory* writable
# (not just the file) for its -wal/-shm sidecars.
RUN mkdir -p /data && chown -R node:node /data
USER node

# Stamped by CI from the git tag; surfaced at /api/health.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
