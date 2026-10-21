-- ADR-0037: the exact Clef input of a checked call. (UpstreamAuth.BUILTIN needs
-- no SQL: SQLite stores the enum as TEXT.)
ALTER TABLE "AuditEntry" ADD COLUMN "pauseCheckInput" TEXT;
