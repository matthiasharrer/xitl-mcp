// Copied from haushalts-todos (lib/mcpOAuth.ts). Stateless OAuth artefacts for
// the MCP authorization server (xitl ADR-0012).
//
// An authorization code, an access token, a refresh token — each is a
// **signed blob**, not a row in a store: `base64url(JSON
// claims).base64url(HMAC-SHA256)`, keyed by the single server secret
// `MCP_TOKEN`. Validation is therefore a signature check plus an expiry check
// and nothing else; there is no token table, no server-side session.
// Rotating `MCP_TOKEN` invalidates every outstanding code/access/refresh
// token at once — for a two-person setup that's "log everyone out".
//
// **Registered clients are the one exception**: a
// `client_id` is an opaque id backing a real `McpClient` row
// (mcp/oauthRoutes.ts), not a blob minted here — Settings lists and
// individually revokes clients, which a self-verifying blob can't support
// (nothing to delete). This module has no client-shaped
// artefact anymore; it only ever dealt with the three that stay blobs.
//
// This module is deliberately **pure crypto + claims** with no SDK or HTTP
// dependency, so it unit-tests in isolation (see mcpOAuth.test.ts). The
// SDK-facing `verifyAccessToken`/`AuthInfo` wrapper and the HTTP endpoints live
// elsewhere and build on these primitives.
import crypto from 'node:crypto';

// --- Lifetimes (seconds) ---------------------------------------------------
export const ACCESS_TTL = 60 * 60; //            1 hour  — short; refresh renews it
export const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days — how long a connector stays linked
export const CODE_TTL = 60; //                   1 minute — an auth code is used within seconds

export type BlobType = 'code' | 'access' | 'refresh';

interface BaseClaims {
  typ: BlobType;
  iat: number; // issued-at, epoch seconds
  exp: number; // expiry, epoch seconds
}

export interface CodeClaims extends BaseClaims {
  typ: 'code';
  cid: string; // the client_id this code was issued to
  uid: number; // the user who approved the consent page (ADR-0012)
  redirect_uri: string; // the exact redirect_uri presented at /authorize
  code_challenge: string; // PKCE S256 challenge, verified at /token
  scope: string[];
}

export interface AccessClaims extends BaseClaims {
  typ: 'access';
  cid: string;
  uid: number; // the user the client is bound to (ADR-0012)
  scope: string[];
}

export interface RefreshClaims extends BaseClaims {
  typ: 'refresh';
  cid: string;
  uid: number;
  scope: string[];
}

// --- Signing / verifying ---------------------------------------------------

function hmac(payloadB64: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** Constant-time string compare that never throws on a length mismatch (it
 * returns false first). Used for both the signature check and the raw-token
 * fallback, so neither leaks its answer through timing on the byte compare. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Signs a set of claims into `base64url(json).base64url(hmac)`. The caller
 * supplies `typ`/`iat`/`exp` via the concrete claim shapes above. */
export function signBlob(claims: BaseClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${hmac(payload, secret)}`;
}

/** Verifies a blob's signature, type and expiry, returning its typed claims or
 * `null` for anything wrong — bad shape, wrong signature, wrong `typ`, or
 * expired. `null` is the only failure signal; callers never distinguish *why*,
 * so a probe can't learn whether it got the type right, the signature close, or
 * merely caught an expired token. */
export function verifyBlob<T extends BaseClaims>(
  token: string,
  typ: T['typ'],
  secret: string,
  nowMs: number = Date.now(),
): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = hmac(payload, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let claims: T;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
  if (!claims || claims.typ !== typ) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return null;
  return claims;
}

// --- Issuers ---------------------------------------------------------------

function base(typ: BlobType, ttl: number, nowMs: number): BaseClaims {
  const iat = Math.floor(nowMs / 1000);
  return { typ, iat, exp: iat + ttl };
}

export function issueAuthCode(
  params: { cid: string; uid: number; redirect_uri: string; code_challenge: string; scope: string[] },
  secret: string,
  nowMs: number = Date.now(),
): string {
  const claims: CodeClaims = { ...(base('code', CODE_TTL, nowMs) as CodeClaims), ...params };
  return signBlob(claims, secret);
}

export function issueAccessToken(
  params: { cid: string; uid: number; scope: string[] },
  secret: string,
  nowMs: number = Date.now(),
): string {
  const claims: AccessClaims = { ...(base('access', ACCESS_TTL, nowMs) as AccessClaims), ...params };
  return signBlob(claims, secret);
}

export function issueRefreshToken(
  params: { cid: string; uid: number; scope: string[] },
  secret: string,
  nowMs: number = Date.now(),
): string {
  const claims: RefreshClaims = { ...(base('refresh', REFRESH_TTL, nowMs) as RefreshClaims), ...params };
  return signBlob(claims, secret);
}

// --- PKCE ------------------------------------------------------------------

/** Verifies a PKCE `code_verifier` against the stored S256 `code_challenge`
 * (`BASE64URL(SHA256(verifier)) === challenge`). S256 only — `plain` is not
 * accepted, matching what the discovery metadata will advertise. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== 'string' || verifier.length === 0) return false;
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return timingSafeEqualStr(hash, challenge);
}
