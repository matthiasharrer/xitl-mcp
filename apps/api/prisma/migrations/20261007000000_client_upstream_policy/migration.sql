-- ADR-0032: a per-client default per upstream (ClientUpstreamPolicy). One new
-- table; DENY hides the upstream from the client. Cascades with the client
-- and the upstream.
-- CreateTable
CREATE TABLE "ClientUpstreamPolicy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "mcpClientId" INTEGER NOT NULL,
    "upstreamId" INTEGER NOT NULL,
    "policy" TEXT NOT NULL,
    CONSTRAINT "ClientUpstreamPolicy_mcpClientId_fkey" FOREIGN KEY ("mcpClientId") REFERENCES "McpClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientUpstreamPolicy_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientUpstreamPolicy_mcpClientId_upstreamId_key" ON "ClientUpstreamPolicy"("mcpClientId", "upstreamId");

