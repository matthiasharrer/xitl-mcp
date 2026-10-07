-- ADR-0026 amendment: Sperre with a purpose. Snooze.purpose / anchorAuditId
-- already exist (deny pauses now fill them too). Plain ADD COLUMN.
ALTER TABLE "AuditEntry" ADD COLUMN "sperreScore" REAL;
