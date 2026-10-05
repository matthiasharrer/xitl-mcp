// Per-upstream access tokens (ADR-0015): generation, hashing, recognition.
// Pure functions, no DB. The token is shown once at creation; only its SHA-256
// (hex) and a short prefix are stored. Never log a token or its hash.
import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'xitl_';
/** Characters of the token kept for recognition in the UI ("xitl_abc1234"). */
export const TOKEN_DISPLAY_PREFIX_LENGTH = 12;

/** `xitl_` + 32 random bytes, base64url (43 chars). */
export function generateAccessToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function hashAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH);
}

/** True when a bearer should be treated as an access token (and NOT handed to
 * the OAuth verifier). */
export function looksLikeAccessToken(bearer: string): boolean {
  return bearer.startsWith(TOKEN_PREFIX);
}
