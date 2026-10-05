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
import { systemClock as clock } from '../lib/clock.js';
import { hashAccessToken, looksLikeAccessToken } from '../lib/accessToken.js';

/** `lastUsedAt` of a token client is bumped at most this often. */
const LAST_USED_MIN_INTERVAL_MS = 60_000;
/** Access tokens do not expire (ADR-0015); the SDK gate insists on an
 * `expiresAt`, so each request gets a short sliding one. */
const TOKEN_REQUEST_TTL_S = 3600;

/** Verifies a per-upstream access token (ADR-0015) for the endpoint
 * `/mcp/<slug>`. Fails closed: ANY mismatch is the same InvalidToken, so a
 * caller cannot tell a wrong token from a wrong slug from a revoked client.
 * The token must (1) hash to a known row, (2) be of kind TOKEN with a bound
 * user and upstream, and (3) the upstream must be the one this user owns under
 * `slug`. Never log the token or its hash. */
export async function verifyAccessTokenForSlug(token: string, slug: string): Promise<AuthInfo> {
  const reject = () => new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid.');
  if (!looksLikeAccessToken(token)) throw reject();
  const client = await prisma.mcpClient.findUnique({ where: { tokenHash: hashAccessToken(token) } });
  if (!client || client.kind !== 'TOKEN' || client.userId === null || client.upstreamId === null) throw reject();
  const upstream = await prisma.upstream.findUnique({
    where: { userId_slug: { userId: client.userId, slug } },
    select: { id: true },
  });
  if (!upstream || upstream.id !== client.upstreamId) throw reject();

  const now = clock.now();
  // Cheap "last used": a conditional UPDATE that matches at most once a minute.
  void prisma.mcpClient
    .updateMany({
      where: { id: client.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_MIN_INTERVAL_MS) } }] },
      data: { lastUsedAt: now },
    })
    .catch(() => undefined);

  return {
    token,
    clientId: client.clientId,
    scopes: ['mcp'],
    expiresAt: Math.floor(now.getTime() / 1000) + TOKEN_REQUEST_TTL_S,
    extra: { userId: client.userId, clientName: client.name, mcpClientId: client.id },
  };
}

/** The verifier for one request to `/mcp/<slug>`: `xitl_…` bearers are access
 * tokens and go ONLY to the token path; everything else goes ONLY to OAuth. */
export function makeGateVerifier(oauth: OAuthTokenVerifier, slug: string): OAuthTokenVerifier {
  return {
    verifyAccessToken: (token: string) =>
      looksLikeAccessToken(token) ? verifyAccessTokenForSlug(token, slug) : oauth.verifyAccessToken(token),
  };
}

/** The verifier for the unified `/mcp` (ADR-0017): OAuth only. A per-upstream
 * access token is scoped to one upstream and is rejected here with the same
 * InvalidToken as any bad token (it never reaches the OAuth path). */
export function makeUnifiedGateVerifier(oauth: OAuthTokenVerifier): OAuthTokenVerifier {
  return {
    verifyAccessToken: async (token: string) => {
      if (looksLikeAccessToken(token)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid.');
      return oauth.verifyAccessToken(token);
    },
  };
}

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
        if (!client || client.kind !== 'OAUTH') {
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
