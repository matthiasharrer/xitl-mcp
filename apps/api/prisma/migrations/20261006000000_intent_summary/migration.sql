-- ADR-0025: intent summary from the local LLM (advisory, never on the decision path).
ALTER TABLE "AuditEntry" ADD COLUMN "intentStatus" TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE "AuditEntry" ADD COLUMN "intentSummary" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "intentRisk" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "intentModelRisk" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "intentLowered" BOOLEAN;
ALTER TABLE "AuditEntry" ADD COLUMN "intentModel" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "intentAt" DATETIME;
ALTER TABLE "AuditEntry" ADD COLUMN "intentPrompt" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "intentAnswer" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "intentContextId" INTEGER;
CREATE INDEX "AuditEntry_intentContextId_idx" ON "AuditEntry"("intentContextId");
