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
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import type { Upstream } from '../generated/prisma/client.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { needsRefresh } from '../lib/upstreamOAuth.js';
import { ReconnectRequired, errorTag, markNeedsReconnect, refreshUpstreamTokens } from './oauthClient.js';

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

/** Is the upstream ready to be called without a connect step? */
export function isUsable(row: Pick<Upstream, 'auth' | 'status' | 'accessToken'>): boolean {
  if (row.auth !== 'OAUTH') return true; // HEADER / NONE need no connect step
  return row.status === 'CONNECTED' && !!row.accessToken;
}

export interface UpstreamSession {
  client: Client;
  /** Current credential values, for scrubbing results (proxyText.scrubSecrets). */
  secrets(): string[];
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
  if (row.auth === 'OAUTH') {
    if (row.status === 'NEEDS_RECONNECT') throw new UpstreamNeedsReconnect();
    if (!isUsable(row)) throw new UpstreamNotConnected();
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
      return fetch(url, {
        ...init,
        headers,
        redirect: 'error',
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    };
    const headers = new Headers(init?.headers);
    if (sameOrigin) {
      if (current.auth === 'HEADER' && current.headerName && current.headerValue) {
        headers.set(current.headerName, current.headerValue);
      }
      if (current.auth === 'OAUTH' && current.accessToken) headers.set('Authorization', `Bearer ${current.accessToken}`);
    }
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
    return res;
  };

  const transport = new StreamableHTTPClientTransport(new URL(current.url), { fetch: fetchFn });
  const client = new Client({ name: 'xitl', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: Math.min(timeoutMs, CONNECT_TIMEOUT_MS) });
    // Remember the upstream's own instructions (ADR-0014): initialize uses them.
    const raw = client.getInstructions();
    const instructions = typeof raw === 'string' ? raw.slice(0, MAX_INSTRUCTIONS) : null;
    if (instructions !== current.instructions) {
      await prisma.upstream.updateMany({ where: { id: current.id, userId }, data: { instructions } });
    }
    return await fn({
      client,
      secrets: () => [current.accessToken, current.refreshToken, current.headerValue].filter((s): s is string => !!s),
    });
  } catch (e) {
    if (reconnect || e instanceof ReconnectRequired) throw new UpstreamNeedsReconnect();
    throw e;
  } finally {
    await client.close().catch((e) => console.warn(`upstream ${upstreamId}: close failed: ${errorTag(e)}`));
  }
}
