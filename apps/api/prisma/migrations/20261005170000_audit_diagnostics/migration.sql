-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN "clientInfo" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "headerNames" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "metaKeys" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "protocolVersion" TEXT;
ALTER TABLE "AuditEntry" ADD COLUMN "userAgent" TEXT;

