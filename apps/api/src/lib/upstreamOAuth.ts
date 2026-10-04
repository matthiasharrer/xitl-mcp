// Pure helpers for xitl's OAuth CLIENT side towards upstreams (ADR-0013):
// the connect-flow state, the pending-auth record and token expiry. No DB, no
// network, time passed in (ADR-0003), so the security-relevant checks are unit
// tested (upstreamOAuth.test.ts). The I/O lives in upstream/oauthClient.ts.
import crypto from 'node:crypto';

/** How long a started connect flow stays redeemable. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** Refresh proactively when the access token expires within this window. */
export const REFRESH_MARGIN_MS = 60 * 1000;

/** What `Upstream.pendingAuth` holds (JSON) while a connect flow is in flight. */
export interface PendingAuth {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  /** ISO timestamp. */
  expiresAt: string;
}

/** `<upstreamId>.<32 random bytes, base64url>`: the id only routes the
 * callback to a row (looked up among the CALLER's upstreams); the random part
 * is the secret that has to match. */
export function makeState(upstreamId: number): string {
  return `${upstreamId}.${crypto.randomBytes(32).toString('base64url')}`;
}

const STATE_PATTERN = /^(\d{1,9})\.[A-Za-z0-9_-]{20,100}$/;

/** The upstream id a state claims to belong to, or null if it is malformed. */
export function upstreamIdFromState(state: unknown): number | null {
  if (typeof state !== 'string') return null;
  const m = STATE_PATTERN.exec(state);
  return m ? Number(m[1]) : null;
}

export function parsePending(raw: string | null): PendingAuth | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingAuth>;
    if (
      typeof v.state === 'string' &&
      typeof v.codeVerifier === 'string' &&
      typeof v.redirectUri === 'string' &&
      typeof v.expiresAt === 'string'
    ) {
      return v as PendingAuth;
    }
  } catch {
    // fall through
  }
  return null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export type PendingCheck = 'ok' | 'missing' | 'mismatch' | 'expired';

/** Is `state` the one this pending flow was started with, and still valid? */
export function checkPending(pending: PendingAuth | null, state: string, now: Date): PendingCheck {
  if (!pending) return 'missing';
  if (!timingSafeEqualStr(pending.state, state)) return 'mismatch';
  const exp = Date.parse(pending.expiresAt);
  if (!Number.isFinite(exp) || now.getTime() >= exp) return 'expired';
  return 'ok';
}

/** Token expiry from a token response's `expires_in` (seconds); null when the
 * AS doesn't say (then only a 401 triggers a refresh). */
export function expiryFrom(expiresIn: number | undefined, now: Date): Date | null {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(now.getTime() + expiresIn * 1000);
}

/** Refresh before use when expired or within REFRESH_MARGIN_MS of expiry. */
export function needsRefresh(expiresAt: Date | null, now: Date): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - now.getTime() <= REFRESH_MARGIN_MS;
}

/** A URL the browser may be sent to: http(s) only (a malicious AS metadata
 * document must not get us to emit `javascript:` or similar). */
export function isNavigableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
