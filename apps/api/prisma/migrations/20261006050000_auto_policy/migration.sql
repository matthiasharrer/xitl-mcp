-- ADR-0030: AUTO policy. The new Policy enum value needs no SQL (SQLite
-- stores enums as TEXT without a CHECK constraint). Plain ADD COLUMNs:
-- existing rows keep their data.
ALTER TABLE "Upstream" ADD COLUMN "autoRule" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "autoScore" REAL;
