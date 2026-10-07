// One short-lived MCP client connection to one user's upstream (ADR-0013),
// with that user's credentials injected. Opened per proxied request and closed
// again (the proxy endpoint is stateless, mcp/mount.ts).
//
// Credentials are added by our own fetch wrapper, never by the caller and
// never from anything the inbound MCP client sent:
// - only on requests to the upstream's own origin,
// - redirects are refused (a redirect would carry a header credential to
//   wherever the upstream points),
// - OAUTH: refreshed before use when expiring (Clock), and on a 401 refreshed
//   once and the request retried once; a second 401 means reconnect.
// Every request goes through the outbound address policy (lib/outbound.ts,
// ADR-0020: no internal addresses), every response is bounded
// (MAX_UPSTREAM_RESPONSE_BYTES, TC-48), and the
// upstream's instructions are scrubbed of our own credentials before they are
// stored (they are handed to agents).
//
// ADR-0033: a paused upstream (`pausedAt` set) is never contacted: the re-read
// row is checked before anything else (no token refresh, no connect, no
// request), and UpstreamPaused is thrown. The callers check the pause earlier
// themselves; this is the backstop for any path that forgets to.
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import type { Upstream } from '../generated/prisma/client.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { needsRefresh } from '../lib/upstreamOAuth.js';
import { limitResponse } from '../lib/limitedResponse.js';
import { outboundFetch, upstreamAllowance } from '../lib/outbound.js';
import { INSTANCE_HEADER, ownInstanceId } from '../lib/selfLoop.js';
import { MAX_UPSTREAM_RESPONSE_BYTES } from '../lib/limits.js';
import { scrubSecrets, type UpstreamState } from '../lib/proxyText.js';
import { ReconnectRequired, errorTag, markNeedsReconnect, refreshUpstreamTokens } from './oauthClient.js';
import { upstreamStates } from './stateEvents.js';

export const CONNECT_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 120_000;
/** Upstream-controlled text we store and hand to agents: bounded. */
const MAX_INSTRUCTIONS = 20_000;

/** The upstream has never been connected (OAUTH). */
export class UpstreamNotConnected extends Error {
  override name = 'UpstreamNotConnected';
}
/** The upstream's tokens are gone: the user must reconnect in xitl (TC-17). */
export class UpstreamNeedsReconnect extends Error {
  override name = 'UpstreamNeedsReconnect';
}

/** ADR-0033: the upstream is paused; nothing was contacted. Not a failure of
 * the upstream (no lastFailureAt, no push). */
export class UpstreamPaused extends Error {
  override name = 'UpstreamPaused';
}

/** Is the upstream ready to be called without a connect step? */
export function isUsable(row: Pick<Upstream, 'auth' | 'status' | 'accessToken'>): boolean {
  if (row.auth !== 'OAUTH') return true; // HEADER / NONE need no connect step
  return row.status === 'CONNECTED' && !!row.accessToken;
}

/** ADR-0022: the state as stored (status, lastFailureAt), without contacting. */
export function storedState(row: Pick<Upstream, 'auth' | 'status' | 'accessToken' | 'lastFailureAt'>): UpstreamState {
  if (row.auth === 'OAUTH' && row.status === 'NEEDS_RECONNECT') return 'reconnect';
  if (!isUsable(row)) return 'not-connected';
  return row.lastFailureAt ? 'unreachable' : 'ok';
}

/**
 * ADR-0022: a failed contact. Conditional on `lastFailureAt: null`, so only the
 * first failure of a run counts (one transition among concurrent failures) and
 * an earlier "since" is kept. Returns whether this was the transition
 * ok -> unreachable (then emitted). Never throws.
 */
export async function recordFailure(upstreamId: number, userId: number, at: Date): Promise<boolean> {
  try {
    const res = await prisma.upstream.updateMany({ where: { id: upstreamId, userId, lastFailureAt: null }, data: { lastFailureAt: at } });
    if (res.count !== 1) return false;
    upstreamStates.emit({ userId, upstreamId, state: 'unreachable', cause: 'transition' });
    return true;
  } catch (err) {
    console.warn(`upstream ${upstreamId}: failure state not stored: ${errorTag(err)}`);
    return false;
  }
}

/** ADR-0022: a successful contact after a failure. Returns whether this was the
 * transition unreachable -> ok (then emitted). Never throws. */
export async function recordSuccess(upstreamId: number, userId: number): Promise<boolean> {
  try {
    const res = await prisma.upstream.updateMany({ where: { id: upstreamId, userId, lastFailureAt: { not: null } }, data: { lastFailureAt: null } });
    if (res.count !== 1) return false;
    upstreamStates.emit({ userId, upstreamId, state: 'ok', cause: 'transition' });
    return true;
  } catch (err) {
    console.warn(`upstream ${upstreamId}: failure state not cleared: ${errorTag(err)}`);
    return false;
  }
}

export interface UpstreamSession {
  client: Client;
  /** Current credential values, for scrubbing results (proxyText.scrubSecrets). */
  secrets(): string[];
}

/** Our credential values for this upstream (what must never reach an agent). */
function secretsOf(row: Upstream): string[] {
  return [row.accessToken, row.refreshToken, row.headerValue].filter((s): s is string => !!s);
}

function urlOf(input: Parameters<FetchLike>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL((input as Request).url);
}

/**
 * Connects to the upstream as `userId` (the row is re-read, scoped by user),
 * runs `fn`, closes. Throws UpstreamNotConnected / UpstreamNeedsReconnect for
 * the connection states, anything else for upstream failures (callers map
 * those to a generic message; never surface the error text).
 */
export async function withUpstream<T>(
  upstreamId: number,
  userId: number,
  fn: (session: UpstreamSession) => Promise<T>,
  opts: { clock?: Clock; timeoutMs?: number } = {},
): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;

  let row = await prisma.upstream.findFirst({ where: { id: upstreamId, userId } });
  if (!row) throw new UpstreamNotConnected();
  // Before the connection states and before any refresh: not contacted at all.
  if (row.pausedAt !== null) throw new UpstreamPaused();
  if (row.auth === 'OAUTH') {
    if (row.status === 'NEEDS_RECONNECT') throw new UpstreamNeedsReconnect();
    if (!isUsable(row)) throw new UpstreamNotConnected();
  }

  // ADR-0022: from here on a failed contact is recorded (lastFailureAt), a
  // successful one clears it. The connection states above and the reconnect
  // outcomes below are tracked by `status` alone. Bookkeeping never changes
  // the outcome.
  const hadFailure = row.lastFailureAt !== null;
  try {
    const result = await contact(row);
    if (hadFailure) await recordSuccess(upstreamId, userId);
    return result;
  } catch (e) {
    if (!(e instanceof UpstreamNotConnected) && !(e instanceof UpstreamNeedsReconnect)) await recordFailure(upstreamId, userId, clock.now());
    throw e;
  }

  async function contact(row: Upstream): Promise<T> {
    if (row.auth === 'OAUTH') {
      if (needsRefresh(row.tokenExpiresAt, clock.now())) {
        try {
          row = await refreshUpstreamTokens(row, { clock });
        } catch (e) {
          if (e instanceof ReconnectRequired) throw new UpstreamNeedsReconnect();
          throw e;
        }
      }
    }

    let current: Upstream = row;
    const origin = new URL(current.url).origin;
    let refreshedOnce = false;
    let reconnect = false;

    const fetchFn: FetchLike = async (input, init) => {
      const url = urlOf(input);
      const sameOrigin = url.origin === origin;
      const send = (headers: Headers) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        return outboundFetch(
          url,
          {
            ...init,
            headers,
            redirect: 'error',
            signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
          },
          // ADR-0020: a flagged upstream may reach its own host:port, from the
          // row as read for this request (never cached across requests).
          { alsoAllow: upstreamAllowance(current) },
        );
      };
      const headers = new Headers(init?.headers);
      if (sameOrigin) {
        if (current.auth === 'HEADER' && current.headerName && current.headerValue) {
          headers.set(current.headerName, current.headerValue);
        }
        if (current.auth === 'OAUTH' && current.accessToken) headers.set('Authorization', `Bearer ${current.accessToken}`);
      }
      // Last, so a configured header of the same name can't drop it (selfLoop.ts).
      headers.set(INSTANCE_HEADER, ownInstanceId());
      let res = await send(headers);
      if (res.status === 401 && sameOrigin && current.auth === 'OAUTH') {
        await res.body?.cancel().catch(() => {});
        if (!refreshedOnce) {
          refreshedOnce = true;
          try {
            current = await refreshUpstreamTokens(current, { clock, force: true, failedToken: current.accessToken });
          } catch (e) {
            if (e instanceof ReconnectRequired) reconnect = true;
            throw e;
          }
          headers.set('Authorization', `Bearer ${current.accessToken}`);
          res = await send(headers);
        }
        if (res.status === 401) {
          // Fresh token still refused: it is not going to work without the user.
          reconnect = true;
          await markNeedsReconnect(current.id, current.userId);
        }
      }
      return limitResponse(res, MAX_UPSTREAM_RESPONSE_BYTES);
    };

    const transport = new StreamableHTTPClientTransport(new URL(current.url), { fetch: fetchFn });
    const client = new Client({ name: 'xitl', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: Math.min(timeoutMs, CONNECT_TIMEOUT_MS) });
      // Remember the upstream's own instructions (ADR-0014): initialize uses them.
      const raw = client.getInstructions();
      const instructions = typeof raw === 'string' ? scrubSecrets(raw, secretsOf(current)).slice(0, MAX_INSTRUCTIONS) : null;
      if (instructions !== current.instructions) {
        await prisma.upstream.updateMany({ where: { id: current.id, userId }, data: { instructions } });
      }
      return await fn({
        client,
        secrets: () => secretsOf(current),
      });
    } catch (e) {
      if (reconnect || e instanceof ReconnectRequired) throw new UpstreamNeedsReconnect();
      throw e;
    } finally {
      await client.close().catch((e) => console.warn(`upstream ${upstreamId}: close failed: ${errorTag(e)}`));
    }
  }
}
