// Copied from haushalts-todos (mcp/verifier.ts). The resource-server half of
// the MCP OAuth (ADR-0012): turns a bearer token into the SDK's
// `AuthInfo`, or rejects it. MCP is OAuth-only: the one accepted token shape
// is a signed access-token blob minted by `/mcp/token`, for a client whose
// `McpClient` row still exists AND is bound to the token's user (ADR-0012). Everything else — including the raw
// `MCP_TOKEN`, which is only the HMAC signing secret — is
// `OAuthErrorCode.InvalidToken`, which `requireBearerAuth` (mount.ts) turns
// into the 401 + `WWW-Authenticate` challenge.
//
// No crypto lives here — `verifyBlob` from `lib/mcpOAuth.ts` does the
// signature work; this is just the shape adapter between that module's
// claims and the SDK's `AuthInfo`.
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { verifyBlob, type AccessClaims } from '../lib/mcpOAuth.js';
import { prisma } from '../db.js';

export function makeVerifier(secret: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const claims = verifyBlob<AccessClaims>(token, 'access', secret);
      if (claims) {
        // The blob alone only proves it was signed by us and hasn't expired
        // — it says nothing about whether the client it was issued to still
        // exists. Confirming the row is what makes a future revocation
        // (deleting it) take effect immediately, even for a token that's
        // still within its 1-hour TTL — otherwise "revoke" would be a lie
        // until the token happened to expire on its own.
        const client = await prisma.mcpClient.findUnique({
          where: { clientId: claims.cid },
          include: { user: { select: { id: true } } },
        });
        if (!client) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'The client for this access token no longer exists.');
        }
        // User binding (ADR-0012): the token's signed `uid` must equal the user
        // the client row is bound to, and that user must still exist. An
        // unbound client (userId null) never gets here legitimately - tokens
        // are only minted after consent binds it - so it fails closed too.
        if (client.userId === null || client.user === null || client.userId !== claims.uid) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is not bound to this client\'s user.');
        }
        return {
          token,
          clientId: claims.cid,
          scopes: claims.scope,
          expiresAt: claims.exp,
          // Read by the MCP server (mcp/server.ts) - the ONLY source of "who is
          // acting". clientName is the live (renamable) DB value;
          // mcpClientId is the McpClient row id (policy + audit key later).
          extra: { userId: client.userId, clientName: client.name, mcpClientId: client.id },
        };
      }

      throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid or expired.');
    },
  };
}
