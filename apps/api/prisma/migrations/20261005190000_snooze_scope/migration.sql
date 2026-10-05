-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Snooze" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "upstreamId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'TOOL',
    "toolName" TEXT,
    "mcpClientId" INTEGER NOT NULL,
    "until" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Snooze_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Snooze_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Snooze_mcpClientId_fkey" FOREIGN KEY ("mcpClientId") REFERENCES "McpClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Snooze" ("createdAt", "id", "mcpClientId", "toolName", "until", "upstreamId", "userId") SELECT "createdAt", "id", "mcpClientId", "toolName", "until", "upstreamId", "userId" FROM "Snooze";
DROP TABLE "Snooze";
ALTER TABLE "new_Snooze" RENAME TO "Snooze";
CREATE INDEX "Snooze_userId_upstreamId_toolName_mcpClientId_idx" ON "Snooze"("userId", "upstreamId", "toolName", "mcpClientId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

