-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Upstream" (
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
    "allowInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Upstream_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Upstream" ("accessToken", "auth", "createdAt", "defaultPolicy", "description", "headerName", "headerValue", "id", "instructions", "name", "oauthClient", "oauthMetadata", "pendingAuth", "refreshToken", "slug", "status", "tokenExpiresAt", "updatedAt", "url", "userId") SELECT "accessToken", "auth", "createdAt", "defaultPolicy", "description", "headerName", "headerValue", "id", "instructions", "name", "oauthClient", "oauthMetadata", "pendingAuth", "refreshToken", "slug", "status", "tokenExpiresAt", "updatedAt", "url", "userId" FROM "Upstream";
DROP TABLE "Upstream";
ALTER TABLE "new_Upstream" RENAME TO "Upstream";
CREATE UNIQUE INDEX "Upstream_userId_slug_key" ON "Upstream"("userId", "slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
