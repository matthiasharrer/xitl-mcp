-- ADR-0029: allow pause with AI check (Clef). Plain ADD COLUMNs: existing rows
-- keep their data; existing pauses get no anchor and stay blind.
ALTER TABLE "User" ADD COLUMN "pauseCheck" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Snooze" ADD COLUMN "anchorAuditId" INTEGER;
ALTER TABLE "AuditEntry" ADD COLUMN "pauseCheckScore" REAL;
ALTER TABLE "AuditEntry" ADD COLUMN "pauseCheckChoice" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "pauseSnoozeId" INTEGER;
CREATE INDEX "AuditEntry_pauseSnoozeId_idx" ON "AuditEntry"("pauseSnoozeId");
