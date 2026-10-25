-- ADR-0038 slices 2-3: MCP Apps views per tool. Hand-written (ADD COLUMN /
-- CREATE TABLE), named after the previous migration.
ALTER TABLE "KnownTool" ADD COLUMN "uiMeta" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "prevUiMeta" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "uiResourceUri" TEXT;
ALTER TABLE "KnownTool" ADD COLUMN "uiEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "UiResource" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "upstreamId" INTEGER NOT NULL,
    "uri" TEXT NOT NULL,
    "contentHash" TEXT,
    "acknowledgedHash" TEXT,
    "acknowledgedAt" DATETIME,
    "readAt" DATETIME,
    "csp" TEXT,
    "lastReadFailed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "UiResource_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UiResource_upstreamId_uri_key" ON "UiResource"("upstreamId", "uri");
