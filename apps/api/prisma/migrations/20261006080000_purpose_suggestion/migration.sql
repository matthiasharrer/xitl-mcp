-- Purpose suggestions (TC-172…177): the intent model's two suggested
-- Zeitfreigabe purposes, and whether a stored purpose was typed or a tapped
-- suggestion. Plain ADD COLUMNs: existing rows keep NULL (no suggestion; a
-- purpose without source reads as typed).
ALTER TABLE "AuditEntry" ADD COLUMN "intentPurposeNarrow" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "intentPurposeKind" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "pausePurposeSource" TEXT;
ALTER TABLE "Snooze" ADD COLUMN "purposeSource" TEXT;
