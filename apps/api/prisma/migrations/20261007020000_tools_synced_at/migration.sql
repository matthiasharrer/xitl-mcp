-- ADR-0034: when the upstream's tool list was last synced; a call re-lists
-- first when it is null or older than TOOLS_FRESH_MS. Null = never synced.
ALTER TABLE "Upstream" ADD COLUMN "toolsSyncedAt" DATETIME;
