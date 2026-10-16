-- ADR-0036 (2026-10-16): the human's optional reason when denying a held call.
ALTER TABLE "AuditEntry" ADD COLUMN "denyReason" TEXT;
