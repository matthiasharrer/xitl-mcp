-- ADR-0033: an upstream can be paused (hidden from every client, never
-- contacted). One nullable column, null = active.
ALTER TABLE "Upstream" ADD COLUMN "pausedAt" DATETIME;
