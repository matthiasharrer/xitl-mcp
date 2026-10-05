-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN "anthropicClient" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "cloudTraceId" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "traceId" TEXT;

