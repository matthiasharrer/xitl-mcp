// Prisma 7 configuration (replaces the CLI `--schema`/`--url` flags removed in
// v7). Prisma no longer auto-loads `.env`, so we do it here — `env()` reads the
// value at CLI time (migrate/generate/db execute). The running app loads the
// same `.env` in src/index.ts and builds the driver adapter from
// process.env.DATABASE_URL (src/db.ts): v7 dropped the built-in query engine,
// so a driver adapter is mandatory (.
//
// Paths are relative to this file's directory (apps/api), which is why every
// `prisma` invocation must run with apps/api as its cwd — the npm scripts here
// already do; the Dockerfile and docker-entrypoint.sh cd in first.
//
// The eager env() below is why the `db:generate` / `build` / `db:migrate:check`
// scripts in package.json prefix a throwaway DATABASE_URL: `generate` never
// opens the datasource, but loading this config resolves env() immediately and
// throws when it's unset — and a fresh clone has no .env (only .env.example).
// Since the generated client is gitignored build output (see the generator
// block in prisma/schema.prisma), those scripts have to work with no ambient
// config at all, so they supply a value that is never connected to.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
