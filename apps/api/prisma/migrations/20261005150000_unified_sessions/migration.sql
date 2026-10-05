-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_McpSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "mcpClientId" INTEGER NOT NULL,
    "upstreamId" INTEGER,
    "clientName" TEXT,
    "clientVersion" TEXT,
    "protocolVersion" TEXT,
    "userAgent" TEXT,
    "headerNames" TEXT NOT NULL DEFAULT '[]',
    "metaKeys" TEXT NOT NULL DEFAULT '[]',
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    CONSTRAINT "McpSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "McpSession_mcpClientId_fkey" FOREIGN KEY ("mcpClientId") REFERENCES "McpClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "McpSession_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_McpSession" ("callCount", "clientName", "clientVersion", "createdAt", "endedAt", "headerNames", "id", "lastSeenAt", "mcpClientId", "metaKeys", "protocolVersion", "upstreamId", "userAgent", "userId") SELECT "callCount", "clientName", "clientVersion", "createdAt", "endedAt", "headerNames", "id", "lastSeenAt", "mcpClientId", "metaKeys", "protocolVersion", "upstreamId", "userAgent", "userId" FROM "McpSession";
DROP TABLE "McpSession";
ALTER TABLE "new_McpSession" RENAME TO "McpSession";
CREATE INDEX "McpSession_userId_createdAt_idx" ON "McpSession"("userId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

