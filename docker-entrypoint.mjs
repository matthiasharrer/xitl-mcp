// Container entrypoint: snapshot the DB, bring the schema up to date, then run
// the server.
//
// Plain Node, not a shell script: the runtime image is distroless (ADR-0039)
// and has no shell, no coreutils and no npm/npx. Everything below uses only
// Node built-ins, better-sqlite3 (already a runtime dependency) and the Prisma
// CLI started directly with this same node binary.
//
// Applying migrations here (rather than from an init container or by hand) is
// safe because the deployment is a single replica by design — SQLite has one
// writer, so there is no second instance to race with. `migrate deploy` only
// applies pending migrations and never generates or resets anything.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRISMA_CLI = path.join(APP_DIR, 'node_modules/prisma/build/index.js');
const PRISMA_CONFIG = 'apps/api/prisma.config.ts';
const KEEP_SNAPSHOTS = 5;

// DATABASE_URL is a Prisma "file:" URL (e.g. file:/data/xitl.db); strip the
// scheme to get a plain filesystem path.
const dbPath = (process.env.DATABASE_URL ?? '').replace(/^file:/, '');
const backupDir = path.join(path.dirname(dbPath), 'backups');

// --- Snapshot before migrating -----------------------------------------
//
// A bad migration is the one way this app can lose data, so take a
// consistent, restorable copy immediately before running one.
//
// The DB runs in WAL mode (see apps/api/src/db.ts), so copying the file while
// it's live is not a valid backup — recent commits can still be sitting in the
// -wal sidecar, unmerged. `VACUUM INTO` asks SQLite itself for a consistent
// single-file snapshot, so it's correct even against a live DB.
if (!dbPath) {
  console.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
} else if (!fs.existsSync(dbPath)) {
  // No database yet means this is the first ever deploy — nothing to snapshot.
  console.log(`No existing database at ${dbPath} — first deploy, skipping snapshot.`);
} else if (hasFailedMigration()) {
  // Don't snapshot when a previous boot already left a failed migration
  // behind. Without this, a crashlooping pod snapshots on *every* restart —
  // and since CrashLoopBackOff restarts after 10s, 20s, 40s… the retention
  // below would evict the one good pre-failure snapshot within about three
  // minutes, which is precisely the copy to restore. In that state the DB is
  // half-migrated anyway. `migrate deploy` will fail again below (P3009) and
  // the pod keeps crashlooping, which is correct.
  console.log('A previous migration is still marked failed — keeping existing snapshots');
  console.log('and not taking a new one.');
} else {
  snapshot();
}

console.log('Applying database migrations...');
const migrate = spawnSync(
  process.execPath,
  [PRISMA_CLI, 'migrate', 'deploy', '--config', PRISMA_CONFIG],
  { cwd: APP_DIR, stdio: 'inherit' },
);
if (migrate.status !== 0) {
  console.error(`FATAL: prisma migrate deploy failed (${migrate.error ?? `exit ${migrate.status}`}).`);
  process.exit(migrate.status || 1);
}

// Start the server in this same process. That keeps node as PID 1, so it
// receives SIGTERM directly from the container runtime — index.ts handles it
// and shuts down cleanly (an unhandled SIGTERM at PID 1 would mean a 10s
// SIGKILL on every rollout). This is what `exec node` did in the old shell
// entrypoint.
await import(path.join(APP_DIR, 'apps/api/dist/index.js'));

// A migration counts as failed when Prisma recorded it as started but neither
// finished nor rolled back — the same rows `prisma migrate status` reports as
// "failed migration" and `migrate deploy` refuses with P3009. Reading the table
// directly saves a Prisma CLI start (seconds) on every boot.
function hasFailedMigration() {
  const db = new Database(dbPath, { fileMustExist: true, readonly: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'")
      .get();
    if (!table) return false;
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL')
      .get();
    return n > 0;
  } finally {
    db.close();
  }
}

function snapshot() {
  // Timestamped (UTC, YYYYMMDDHHMMSS) so re-runs never collide — VACUUM INTO
  // fails if the target file already exists.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const target = path.join(backupDir, `${stamp}.db`);
  console.log(`Snapshotting database to ${target} before migrating...`);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.prepare('VACUUM INTO ?').run(target);
    } finally {
      db.close();
    }
  } catch (err) {
    // Fail closed: if the DB exists but we couldn't snapshot it, do NOT
    // migrate. A snapshot failure usually means a full or broken volume —
    // exactly when running a schema migration is most dangerous, because
    // there'd be nothing to restore if it goes wrong.
    console.error(`FATAL: could not snapshot the database before migrating: ${err.message}`);
    console.error(`Refusing to run migrations. Check disk space / permissions on ${path.dirname(dbPath)}.`);
    process.exit(1);
  }

  // Retention: keep the most recent snapshots, newest by modification time.
  const old = fs
    .readdirSync(backupDir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => path.join(backupDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(KEEP_SNAPSHOTS);
  for (const file of old) fs.rmSync(file, { force: true });
}
