-- ADR-0024: pause an access (null = active).
ALTER TABLE "McpClient" ADD COLUMN "pausedAt" DATETIME;
