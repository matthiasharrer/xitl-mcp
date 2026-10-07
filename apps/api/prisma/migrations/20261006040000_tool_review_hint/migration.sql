-- ADR-0031: review hint for new and changed tools, inputSchema change
-- detection. Plain ADD COLUMNs: existing rows keep their data; their
-- inputSchema stays NULL until the next tools/list stores it silently.
ALTER TABLE "KnownTool" ADD COLUMN "inputSchema" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "prevDescription" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "prevAnnotations" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "prevInputSchema" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "urlChanged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "KnownTool" ADD COLUMN "cosmeticAckAt" DATETIME;
ALTER TABLE "KnownTool" ADD COLUMN "hintRisk" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "hintInjection" REAL;
ALTER TABLE "KnownTool" ADD COLUMN "hintAt" DATETIME;
ALTER TABLE "KnownTool" ADD COLUMN "hintFor" TEXT;
