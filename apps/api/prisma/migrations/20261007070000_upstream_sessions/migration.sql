-- ADR-0040: session handles as a tool parameter. Hand-written (ADD COLUMN),
-- named after the previous migration.
ALTER TABLE "Upstream" ADD COLUMN "sessionParam" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "KnownTool" ADD COLUMN "endsSession" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AuditEntry" ADD COLUMN "upstreamSession" TEXT;
