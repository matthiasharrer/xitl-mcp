-- CreateTable
CREATE TABLE "Upstream" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "defaultPolicy" TEXT NOT NULL DEFAULT 'ASK',
    "auth" TEXT NOT NULL DEFAULT 'OAUTH',
    "status" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "oauthClient" TEXT,
    "oauthMetadata" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "pendingAuth" TEXT,
    "headerName" TEXT,
    "headerValue" TEXT,
    "instructions" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Upstream_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnownTool" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "upstreamId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "annotations" TEXT,
    "policy" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME,
    CONSTRAINT "KnownTool_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientToolPolicy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "toolId" INTEGER NOT NULL,
    "mcpClientId" INTEGER NOT NULL,
    "policy" TEXT NOT NULL,
    CONSTRAINT "ClientToolPolicy_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "KnownTool" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientToolPolicy_mcpClientId_fkey" FOREIGN KEY ("mcpClientId") REFERENCES "McpClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Snooze" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "upstreamId" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "mcpClientId" INTEGER NOT NULL,
    "until" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Snooze_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Snooze_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Snooze_mcpClientId_fkey" FOREIGN KEY ("mcpClientId") REFERENCES "McpClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "McpClient" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT NOT NULL,
    "userId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    CONSTRAINT "McpClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEntry" (
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
    CONSTRAINT "AuditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditEntry_mcpClientId_fkey" FOREIGN KEY ("mcpClientId") REFERENCES "McpClient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEntry_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" DATETIME,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Upstream_userId_slug_key" ON "Upstream"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "KnownTool_upstreamId_name_key" ON "KnownTool"("upstreamId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ClientToolPolicy_toolId_mcpClientId_key" ON "ClientToolPolicy"("toolId", "mcpClientId");

-- CreateIndex
CREATE INDEX "Snooze_userId_upstreamId_toolName_mcpClientId_idx" ON "Snooze"("userId", "upstreamId", "toolName", "mcpClientId");

-- CreateIndex
CREATE UNIQUE INDEX "McpClient_clientId_key" ON "McpClient"("clientId");

-- CreateIndex
CREATE INDEX "McpClient_userId_idx" ON "McpClient"("userId");

-- CreateIndex
CREATE INDEX "AuditEntry_userId_receivedAt_idx" ON "AuditEntry"("userId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");
