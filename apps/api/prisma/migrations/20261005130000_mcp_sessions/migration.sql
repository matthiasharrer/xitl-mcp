-- CreateTable
CREATE TABLE "McpSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "mcpClientId" INTEGER NOT NULL,
    "upstreamId" INTEGER NOT NULL,
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

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "mcpClientId" INTEGER,
    "upstreamId" INTEGER,
    "endpoint" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "arguments" TEXT NOT NULL,
    "policy" TEXT NOT NULL,
    "decisionPath" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "isError" BOOLEAN,
    "resultText" TEXT,
    "receivedAt" DATETIME NOT NULL,
    "decidedAt" DATETIME,
    "finishedAt" DATETIME,
    "approvalId" TEXT,
    "sessionId" TEXT,
    CONSTRAINT "AuditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditEntry_mcpClientId_fkey" FOREIGN KEY ("mcpClientId") REFERENCES "McpClient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEntry_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEntry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "McpSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AuditEntry" ("approvalId", "arguments", "decidedAt", "decisionPath", "endpoint", "finishedAt", "id", "isError", "mcpClientId", "outcome", "policy", "receivedAt", "resultText", "toolName", "upstreamId", "userId") SELECT "approvalId", "arguments", "decidedAt", "decisionPath", "endpoint", "finishedAt", "id", "isError", "mcpClientId", "outcome", "policy", "receivedAt", "resultText", "toolName", "upstreamId", "userId" FROM "AuditEntry";
DROP TABLE "AuditEntry";
ALTER TABLE "new_AuditEntry" RENAME TO "AuditEntry";
CREATE UNIQUE INDEX "AuditEntry_approvalId_key" ON "AuditEntry"("approvalId");
CREATE INDEX "AuditEntry_userId_receivedAt_idx" ON "AuditEntry"("userId", "receivedAt");
CREATE INDEX "AuditEntry_sessionId_idx" ON "AuditEntry"("sessionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "McpSession_userId_createdAt_idx" ON "McpSession"("userId", "createdAt");
