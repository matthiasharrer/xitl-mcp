#!/bin/sh
# Container entrypoint: snapshot the DB, bring the schema up to date, then run
# the server.
#
# Applying migrations here (rather than from an init container or by hand) is
# safe because the deployment is a single replica by design — SQLite has one
# writer, so there is no second instance to race with. `migrate deploy` only
# applies pending migrations and never generates or resets anything.
set -e

# --- Snapshot before migrating -----------------------------------------
#
# A bad migration is the one way this app can lose data, so take a
# consistent, restorable copy immediately before running one. Restoring is
# covered in the failed-migration runbook.
#
# The DB runs in WAL mode (see apps/api/src/db.ts), so `cp`-ing the file
# while it's live is not a valid backup — recent commits can still be sitting
# in the -wal sidecar, unmerged. `VACUUM INTO` asks SQLite itself for a
# consistent single-file snapshot, so it's correct even against a live DB.
#
# DATABASE_URL is a Prisma "file:" URL (e.g. file:/data/xitl.db); strip the
# scheme to get a plain filesystem path.
DB_PATH=${DATABASE_URL#file:}
BACKUP_DIR="$(dirname "$DB_PATH")/backups"

# Don't snapshot when a previous boot already left a failed migration behind.
# Without this, a crashlooping pod snapshots on *every* restart — and since
# CrashLoopBackOff restarts after 10s, 20s, 40s… the retention below would
# evict the one good pre-failure snapshot within about three minutes, which is
# precisely the copy the runbook tells you to restore. In that state the DB is
# half-migrated anyway, so a fresh snapshot of it is worth less than the ones
# it would push out. `migrate deploy` will fail again below (P3009) and the
# pod keeps crashlooping, which is correct: see
# the failed-migration runbook.
MIGRATION_ALREADY_FAILED=0
if [ -f "$DB_PATH" ]; then
  if npx prisma migrate status --config apps/api/prisma.config.ts 2>&1 \
    | grep -qi "failed migration"; then
    MIGRATION_ALREADY_FAILED=1
  fi
fi

if [ -f "$DB_PATH" ] && [ "$MIGRATION_ALREADY_FAILED" -eq 1 ]; then
  echo "A previous migration is still marked failed — keeping existing snapshots"
  echo "and not taking a new one. See the failed-migration runbook."
elif [ -f "$DB_PATH" ]; then
  mkdir -p "$BACKUP_DIR"

  # Timestamped so re-runs never collide — VACUUM INTO fails if the target
  # file already exists.
  SNAPSHOT="$BACKUP_DIR/$(date -u +%Y%m%d%H%M%S).db"
  echo "Snapshotting database to $SNAPSHOT before migrating..."

  # `prisma db execute --stdin` is the simplest way to run a raw SQL
  # statement with the CLI that's already a runtime dependency here — no
  # extra tool needed.
  #
  # Prisma 7: `--url` is gone; the CLI reads the datasource from
  # apps/api/prisma.config.ts (`datasource.url = env("DATABASE_URL")`), and
  # DATABASE_URL is already exported into this container. `db execute` opens
  # that URL directly, so no driver adapter is needed for this CLI path.
  #
  # Guard it explicitly rather than relying on `set -e`:
  # we want a clear, loud failure message before refusing to migrate, not
  # just "script exited 1".
  if printf "VACUUM INTO '%s';" "$SNAPSHOT" | npx prisma db execute --stdin --config apps/api/prisma.config.ts; then
    # Retention: keep the 5 most recent snapshots. `ls -t` lists newest
    # first; drop the first 5 and delete the rest.
    ls -t "$BACKUP_DIR"/*.db 2>/dev/null | tail -n +6 | while IFS= read -r old_snapshot; do
      rm -f "$old_snapshot"
    done
  else
    # Fail closed: if the DB exists but we couldn't snapshot it, do NOT
    # migrate. A snapshot failure usually means a full or broken volume —
    # exactly when running a schema migration is most dangerous, because
    # there'd be nothing to restore if it goes wrong.
    echo "FATAL: could not snapshot the database before migrating." >&2
    echo "Refusing to run migrations. Check disk space / permissions on $(dirname "$DB_PATH")." >&2
    exit 1
  fi
else
  # No database yet means this is the first ever deploy — nothing to snapshot.
  echo "No existing database at $DB_PATH — first deploy, skipping snapshot."
fi

echo "Applying database migrations..."
npx prisma migrate deploy --config apps/api/prisma.config.ts

# exec so node becomes PID 1 and receives SIGTERM directly from the container
# runtime — index.ts handles it and shuts down cleanly (see graceful shutdown
# there; an unhandled SIGTERM at PID 1 would mean a 10s SIGKILL on every
# rollout).
exec node apps/api/dist/index.js
