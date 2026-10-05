-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_McpClient" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OAUTH',
    "userId" INTEGER,
    "upstreamId" INTEGER,
    "tokenHash" TEXT,
    "tokenPrefix" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    CONSTRAINT "McpClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "McpClient_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_McpClient" ("clientId", "createdAt", "id", "lastUsedAt", "name", "redirectUris", "userId") SELECT "clientId", "createdAt", "id", "lastUsedAt", "name", "redirectUris", "userId" FROM "McpClient";
DROP TABLE "McpClient";
ALTER TABLE "new_McpClient" RENAME TO "McpClient";
CREATE UNIQUE INDEX "McpClient_clientId_key" ON "McpClient"("clientId");
CREATE UNIQUE INDEX "McpClient_tokenHash_key" ON "McpClient"("tokenHash");
CREATE INDEX "McpClient_userId_idx" ON "McpClient"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

