-- ADR-0029 amendment: optional purpose ("Wofür?") of a Zeitfreigabe. Plain
-- ADD COLUMNs: existing pauses have none and are checked as before.
ALTER TABLE "Snooze" ADD COLUMN "purpose" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "pausePurpose" TEXT;
