// MCP client connections to one user's upstream (ADR-0013), with that user's
// credentials injected. By default opened per request and closed again.
// ADR-0040: for an upstream with `sessionParam`, a forwarded `tools/call` runs
// in a kept upstream session named by a handle xitl minted (the agent passes
// it back as `xitl_session`, mcp/server.ts), so a stateful upstream
// (Playwright: tabs, cookies) keeps its state between calls
// (UpstreamSessionPool). One-shot connections to such an upstream end their
// upstream session (DELETE) before closing.
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
// ADR-0037: a BUILTIN row (the in-process `xitl` upstream) is never contacted
// over HTTP: the Client is linked to an in-process server for that row's user
// over an in-memory transport. No fetch, no credentials, no instance header.
//
// ADR-0033: a paused upstream (`pausedAt` set) is never contacted: the re-read
// row is checked before anything else (no token refresh, no connect, no
// request), and UpstreamPaused is thrown. The callers check the pause earlier
// themselves; this is the backstop for any path that forgets to.
import { randomBytes } from 'node:crypto';
import { Client, SdkHttpError, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { prisma } from '../db.js';
import type { Upstream } from '../generated/prisma/client.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { needsRefresh } from '../lib/upstreamOAuth.js';
import { limitResponse } from '../lib/limitedResponse.js';
import { outboundFetch, upstreamAllowance } from '../lib/outbound.js';
import { INSTANCE_HEADER, ownInstanceId } from '../lib/selfLoop.js';
import { MAX_UPSTREAM_RESPONSE_BYTES, MAX_UPSTREAM_SESSIONS, UPSTREAM_SESSION_IDLE_MS } from '../lib/limits.js';
import { scrubSecrets, type UpstreamState } from '../lib/proxyText.js';
import { ReconnectRequired, errorTag, markNeedsReconnect, refreshUpstreamTokens } from './oauthClient.js';
import { upstreamStates } from './stateEvents.js';
import { buildBuiltinServer } from '../builtin/server.js';

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

/** The kinds withUpstream knows how to reach; any other value is refused. */
const KNOWN_AUTH: readonly string[] = ['OAUTH', 'HEADER', 'NONE', 'BUILTIN'];

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

/** Mutable per-connection state the fetch wrapper reads on every request. A
 * kept connection (ADR-0040) gets each call's re-read row and timeout here. */
interface FetchContext {
  current: Upstream;
  /** Credentials go only here (the row's origin when the connection opened). */
  readonly origin: string;
  timeoutMs: number;
  refreshedOnce: boolean;
  reconnect: boolean;
  /** Kept between calls: no standalone GET stream (see makeFetch). */
  readonly persistent: boolean;
  /** Ending the session (DELETE): a 401 then is not refreshed or recorded. */
  closing: boolean;
  readonly clock: Clock;
}

interface HttpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  ctx: FetchContext;
}

interface PooledHttp extends HttpConnection {
  key: string;
  userId: number;
  upstreamId: number;
  /** The MCP client the handle was minted for: only found by that client. */
  mcpClientId: number;
  handle: string;
  closed: boolean;
  /** What the connection was opened for; a changed row is a new connection. */
  identity: string;
  lastUsedAt: number;
  inFlight: number;
}

function newContext(row: Upstream, o: { clock: Clock; timeoutMs: number; persistent: boolean }): FetchContext {
  return { current: row, origin: new URL(row.url).origin, timeoutMs: o.timeoutMs, refreshedOnce: false, reconnect: false, persistent: o.persistent, closing: false, clock: o.clock };
}

/** Upstream session diagnostics (ADR-0040), off unless XITL_DEBUG_UPSTREAM_SESSIONS=1:
 * per request the HTTP method, JSON-RPC method(s), status and the first
 * characters of the session id sent / received. Never headers or bodies. */
const debugSessions = process.env.XITL_DEBUG_UPSTREAM_SESSIONS === '1';
const sid = (v: string | null | undefined) => (v ? `${v.slice(0, 8)}…` : '-');
function rpcMethodsOf(body: unknown): string {
  if (typeof body !== 'string') return '-';
  try {
    const parsed = JSON.parse(body) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((m) => (m && typeof m === 'object' && typeof (m as { method?: unknown }).method === 'string' ? (m as { method: string }).method : 'response')).join(',').slice(0, 200);
  } catch {
    return '?';
  }
}

/** The fetch every upstream request goes through: credentials, outbound policy,
 * 401 refresh, response bound. */
function makeFetch(ctx: FetchContext): FetchLike {
  return async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    // ADR-0040: a kept connection opens no standalone GET (SSE) stream. xitl
    // forwards no server-initiated messages, and on that stream Playwright MCP
    // starts a ping heartbeat that ends the session (and the browser context)
    // whenever a ping goes unanswered for 5 s. 405 is "no stream" by the spec.
    if (ctx.persistent && method === 'GET') return new Response(null, { status: 405 });
    const sameOrigin = url.origin === ctx.origin;
    const send = (headers: Headers) => {
      const timeout = AbortSignal.timeout(ctx.timeoutMs);
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
        { alsoAllow: upstreamAllowance(ctx.current) },
      );
    };
    const headers = new Headers(init?.headers);
    if (sameOrigin) {
      const current = ctx.current;
      if (current.auth === 'HEADER' && current.headerName && current.headerValue) {
        headers.set(current.headerName, current.headerValue);
      }
      if (current.auth === 'OAUTH' && current.accessToken) headers.set('Authorization', `Bearer ${current.accessToken}`);
    }
    // Last, so a configured header of the same name can't drop it (selfLoop.ts).
    headers.set(INSTANCE_HEADER, ownInstanceId());
    let res = await send(headers);
    if (res.status === 401 && sameOrigin && ctx.current.auth === 'OAUTH' && !ctx.closing) {
      await res.body?.cancel().catch(() => {});
      if (!ctx.refreshedOnce) {
        ctx.refreshedOnce = true;
        try {
          ctx.current = await refreshUpstreamTokens(ctx.current, { clock: ctx.clock, force: true, failedToken: ctx.current.accessToken });
        } catch (e) {
          if (e instanceof ReconnectRequired) ctx.reconnect = true;
          throw e;
        }
        headers.set('Authorization', `Bearer ${ctx.current.accessToken}`);
        res = await send(headers);
      }
      if (res.status === 401) {
        // Fresh token still refused: it is not going to work without the user.
        ctx.reconnect = true;
        await markNeedsReconnect(ctx.current.id, ctx.current.userId);
      }
    }
    if (debugSessions) {
      console.log(
        `upstream ${ctx.current.id}: ${method} ${rpcMethodsOf(init?.body)} sid>${sid(headers.get('mcp-session-id'))} ` +
          `sid<${sid(res.headers.get('mcp-session-id'))} ${res.status}${ctx.persistent ? ' kept' : ''}`,
      );
    }
    return limitResponse(res, MAX_UPSTREAM_RESPONSE_BYTES);
  };
}

/** Connects (initialize) and stores the upstream's instructions (ADR-0014). */
async function openHttp(ctx: FetchContext): Promise<HttpConnection> {
  const row = ctx.current;
  const transport = new StreamableHTTPClientTransport(new URL(row.url), { fetch: makeFetch(ctx) });
  const client = new Client({ name: 'xitl', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: Math.min(ctx.timeoutMs, CONNECT_TIMEOUT_MS) });
    const raw = client.getInstructions();
    const instructions = typeof raw === 'string' ? scrubSecrets(raw, secretsOf(ctx.current)).slice(0, MAX_INSTRUCTIONS) : null;
    if (instructions !== ctx.current.instructions) {
      await prisma.upstream.updateMany({ where: { id: ctx.current.id, userId: ctx.current.userId }, data: { instructions } });
    }
    return { client, transport, ctx };
  } catch (e) {
    await client.close().catch(() => {});
    if (ctx.reconnect || e instanceof ReconnectRequired) throw new UpstreamNeedsReconnect();
    throw e;
  }
}

/** Closes the connection; with `terminate`, ends the upstream's session first
 * (DELETE; a no-op without a session id). Never throws. */
async function closeHttp(conn: HttpConnection, terminate: boolean): Promise<void> {
  const id = conn.ctx.current.id;
  conn.ctx.closing = true;
  if (terminate) await conn.transport.terminateSession().catch((e) => console.warn(`upstream ${id}: session end failed: ${errorTag(e)}`));
  await conn.client.close().catch((e) => console.warn(`upstream ${id}: close failed: ${errorTag(e)}`));
}

/** The upstream no longer knows our session (MCP: 404; some servers say 400). */
function isSessionGone(e: unknown): boolean {
  if (!(e instanceof SdkHttpError)) return false;
  const data = (e as { data?: { status?: unknown; text?: unknown } }).data;
  if (data?.status === 404) return true;
  return data?.status === 400 && typeof data.text === 'string' && /session/i.test(data.text);
}

function identityOf(row: Upstream): string {
  return JSON.stringify([row.url, row.auth]);
}

function poolKey(userId: number, upstreamId: number, handle: string): string {
  return `${userId}:${upstreamId}:${handle}`;
}

/** ADR-0040: a session handle is 128 random bits, base64url (22 characters). */
const HANDLE_RE = /^[A-Za-z0-9_-]{22}$/;

/** Could `v` be a handle xitl minted? Anything else is never looked up. */
export function isHandleShaped(v: unknown): v is string {
  return typeof v === 'string' && HANDLE_RE.test(v);
}

function newHandle(): string {
  return randomBytes(16).toString('base64url');
}

/** ADR-0040: a call to an upstream with `sessionParam` (mcp/server.ts forward). */
export interface KeptSessionRequest {
  /** From the token check (mount.ts); a handle is only found by this client. */
  mcpClientId: number;
  /** The handle the call passed as `xitl_session` (handle-shaped), else null. */
  handle: string | null;
  /** Something was passed, even if not handle-shaped (then: `replaced`). */
  given?: boolean;
}

/** Which session the call ran in. `new`: opened, no handle was passed;
 * `replaced`: the passed handle was unknown, foreign or ended (one answer for
 * all three), a new one was opened; `restarted`: the upstream had lost the
 * session, it was opened again under the same handle; `kept`: reused. */
export interface KeptSessionOutcome {
  handle: string;
  kind: 'new' | 'replaced' | 'restarted' | 'kept';
}

/** The kept upstream sessions (ADR-0040), keyed by user + upstream + handle.
 * In memory: one replica (ADR-0001); a restart drops them (handles become
 * unknown) and the upstream's own timeout cleans up. */
class UpstreamSessionPool {
  private conns = new Map<string, PooledHttp>();
  private opening = new Map<string, Promise<PooledHttp>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** The kept connection for `key` if this client owns it and it is still
   * usable for this row. Another client's handle is simply not found. */
  take(key: string, row: Upstream, mcpClientId: number, now: Date): PooledHttp | null {
    this.sweep(now);
    const conn = this.conns.get(key);
    if (!conn || conn.mcpClientId !== mcpClientId) return null;
    // A changed URL or auth kind is another upstream: never send the new
    // credentials into the old session (nor the old ones anywhere: no DELETE).
    if (conn.identity !== identityOf(row) || !conn.client.transport) {
      this.discard(conn, false);
      return null;
    }
    return conn;
  }

  /** Opens and keeps a connection under `key`; concurrent opens of one key
   * (a restart seen by two calls) share one. */
  async open(key: string, owner: { userId: number; upstreamId: number; mcpClientId: number; handle: string }, open: () => Promise<HttpConnection>, now: Date): Promise<PooledHttp> {
    const existing = this.conns.get(key);
    if (existing) return existing;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const conn = await open();
      const pooled: PooledHttp = { ...conn, key, ...owner, closed: false, identity: identityOf(conn.ctx.current), lastUsedAt: now.getTime(), inFlight: 0 };
      this.makeRoom();
      this.conns.set(key, pooled);
      this.startTimer();
      return pooled;
    })();
    this.opening.set(key, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(key);
    }
  }

  /** Drops the connection (once); with `terminate`, the upstream session is
   * ended first (DELETE). Resolves when closed; never throws. */
  discard(conn: PooledHttp, terminate: boolean): Promise<void> {
    if (this.conns.get(conn.key) === conn) this.conns.delete(conn.key);
    if (this.conns.size === 0) this.stopTimer();
    if (conn.closed) return Promise.resolve();
    conn.closed = true;
    return closeHttp(conn, terminate);
  }

  /** The end tool succeeded (ADR-0040): ends the session behind this
   * client's handle (DELETE). False when there was none. */
  async end(userId: number, upstreamId: number, mcpClientId: number, handle: string): Promise<boolean> {
    const conn = this.conns.get(poolKey(userId, upstreamId, handle));
    if (!conn || conn.mcpClientId !== mcpClientId) return false;
    await this.discard(conn, true);
    return true;
  }

  /** Drops every kept session of one upstream (switched off, URL or auth
   * changed, deleted). Not contacted unless `terminate`: after a URL or auth
   * change the old session must not see either credential. */
  endUpstream(userId: number, upstreamId: number, opts: { terminate?: boolean } = {}): void {
    for (const conn of [...this.conns.values()]) {
      if (conn.userId === userId && conn.upstreamId === upstreamId) void this.discard(conn, opts.terminate === true);
    }
  }

  /** Ends (DELETE) every idle session not used for UPSTREAM_SESSION_IDLE_MS. */
  sweep(now: Date): void {
    for (const conn of [...this.conns.values()]) {
      if (conn.inFlight === 0 && now.getTime() - conn.lastUsedAt >= UPSTREAM_SESSION_IDLE_MS) void this.discard(conn, true);
    }
  }

  get size(): number {
    return this.conns.size;
  }

  /** Tests: drop everything without contacting anyone. */
  reset(): void {
    for (const conn of [...this.conns.values()]) void this.discard(conn, false);
  }

  private makeRoom(): void {
    while (this.conns.size >= MAX_UPSTREAM_SESSIONS) {
      let oldest: PooledHttp | null = null;
      for (const c of this.conns.values()) if (c.inFlight === 0 && (!oldest || c.lastUsedAt < oldest.lastUsedAt)) oldest = c;
      if (!oldest) return; // all in use: over the cap for a while rather than break a call
      void this.discard(oldest, true);
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(systemClock.now()), 60_000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const upstreamSessions = new UpstreamSessionPool();
const pool = upstreamSessions;

/**
 * Connects to the upstream as `userId` (the row is re-read, scoped by user),
 * runs `fn`, closes. Throws UpstreamNotConnected / UpstreamNeedsReconnect for
 * the connection states, anything else for upstream failures (callers map
 * those to a generic message; never surface the error text).
 *
 * With `kept` (ADR-0040, an upstream with sessionParam) the call runs in a
 * kept upstream session instead (see contactKept); every check above still
 * runs per call. `onSession` then reports which session it ran in.
 */
export async function withUpstream<T>(
  upstreamId: number,
  userId: number,
  fn: (session: UpstreamSession) => Promise<T>,
  opts: { clock?: Clock; timeoutMs?: number; kept?: KeptSessionRequest; onSession?: (o: KeptSessionOutcome) => void } = {},
): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;

  let row = await prisma.upstream.findFirst({ where: { id: upstreamId, userId } });
  if (!row) throw new UpstreamNotConnected();
  // Before the connection states and before any refresh: not contacted at all.
  if (row.pausedAt !== null) throw new UpstreamPaused();
  // Fail closed: a kind this code doesn't know is never contacted.
  if (!KNOWN_AUTH.includes(row.auth)) throw new UpstreamNotConnected();
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
    if (row.auth === 'BUILTIN') return contactBuiltin(row);
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
    if (opts.kept) return contactKept(row, opts.kept);

    const conn = await openHttp(newContext(row, { clock, timeoutMs, persistent: false }));
    try {
      return await fn(sessionOf(conn));
    } catch (e) {
      if (conn.ctx.reconnect || e instanceof ReconnectRequired) throw new UpstreamNeedsReconnect();
      throw e;
    } finally {
      // ADR-0040: an upstream with sessions gets its session ended (DELETE),
      // so it can free what it holds (a browser context).
      await closeHttp(conn, row.sessionParam && !conn.ctx.reconnect);
    }
  }

  /** ADR-0040: runs the call in the session behind the passed handle, or
   * opens one under a new handle (none passed, or unknown / foreign / ended).
   * A kept session the upstream no longer knows is opened again once under
   * the same handle and the call repeated (a 404 comes before the call runs);
   * one opened for this call is not retried. */
  async function contactKept(row: Upstream, req: KeptSessionRequest): Promise<T> {
    const open = (handle: string) =>
      pool.open(
        poolKey(userId, upstreamId, handle),
        { userId, upstreamId, mcpClientId: req.mcpClientId, handle },
        () => openHttp(newContext(row, { clock, timeoutMs, persistent: true })),
        clock.now(),
      );
    let conn = req.handle ? pool.take(poolKey(userId, upstreamId, req.handle), row, req.mcpClientId, clock.now()) : null;
    const kind: KeptSessionOutcome['kind'] = conn ? 'kept' : req.handle || req.given ? 'replaced' : 'new';
    conn ??= await open(newHandle());
    let result: T;
    try {
      result = await use(conn);
    } catch (e) {
      if (kind !== 'kept') {
        // Nobody holds this handle yet: end the session it opened.
        await pool.discard(conn, !conn.ctx.reconnect);
        throw e;
      }
      if (!isSessionGone(e)) throw e;
      // The upstream forgot the session (restart, its own timeout).
      await pool.discard(conn, false);
      conn = await open(conn.handle);
      result = await use(conn);
      opts.onSession?.({ handle: conn.handle, kind: 'restarted' });
      return result;
    }
    opts.onSession?.({ handle: conn.handle, kind });
    return result;

    async function use(c: PooledHttp): Promise<T> {
      // Each call: this request's row (credentials), timeout and 401 budget.
      c.ctx.current = row;
      c.ctx.timeoutMs = timeoutMs;
      c.ctx.refreshedOnce = false;
      c.ctx.reconnect = false;
      c.inFlight++;
      try {
        return await fn(sessionOf(c));
      } catch (e) {
        if (c.ctx.reconnect || e instanceof ReconnectRequired) {
          await pool.discard(c, false);
          throw new UpstreamNeedsReconnect();
        }
        throw e;
      } finally {
        c.inFlight--;
        c.lastUsedAt = clock.now().getTime();
      }
    }
  }

  function sessionOf(conn: HttpConnection): UpstreamSession {
    return { client: conn.client, secrets: () => secretsOf(conn.ctx.current) };
  }

  /** ADR-0037: the in-process server for this row's user, linked in memory. */
  async function contactBuiltin(row: Upstream): Promise<T> {
    const server = buildBuiltinServer(row.userId);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'xitl', version: '0.1.0' });
    try {
      await server.connect(serverSide);
      await client.connect(clientSide, { timeout: Math.min(timeoutMs, CONNECT_TIMEOUT_MS) });
      const raw = client.getInstructions();
      const instructions = typeof raw === 'string' ? raw.slice(0, MAX_INSTRUCTIONS) : null;
      if (instructions !== row.instructions) {
        await prisma.upstream.updateMany({ where: { id: row.id, userId }, data: { instructions } });
      }
      // No credentials exist for this kind: nothing to scrub.
      return await fn({ client, secrets: () => [] });
    } finally {
      await client.close().catch((e) => console.warn(`upstream ${upstreamId}: close failed: ${errorTag(e)}`));
      await server.close().catch((e) => console.warn(`upstream ${upstreamId}: close failed: ${errorTag(e)}`));
    }
  }
}
