-- ADR-0023: browser origins per access token (JSON array, "[]" = none).
ALTER TABLE "McpClient" ADD COLUMN "allowedOrigins" TEXT NOT NULL DEFAULT '[]';
