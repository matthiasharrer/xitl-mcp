-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN "approvalId" TEXT;

-- AlterTable
ALTER TABLE "KnownTool" ADD COLUMN "changedAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "AuditEntry_approvalId_key" ON "AuditEntry"("approvalId");

