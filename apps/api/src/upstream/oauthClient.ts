// xitl as an OAuth CLIENT towards one user's OAUTH upstream (ADR-0013).
//
// Built from the client SDK's standalone helpers (discoverOAuthServerInfo,
// registerClient, startAuthorization, exchangeAuthorization,
// refreshAuthorization): they do RFC 9728/8414 discovery, DCR, PKCE and the
// token requests. The SDK's `auth()` orchestrator / OAuthClientProvider is NOT
// used: it is built around one in-process session that also owns `state`, while
// here the flow is split across two HTTP requests of a multi-user web app, the
// callback has to be bound to the user who started it (TC-16), state must be
// single-use and time must come from the injected Clock (ADR-0003). So the
// orchestration (state, pending record, storage, refresh locking) is ours.
//
// Secrets (tokens, client secret, PKCE verifier) live only in the Upstream row.
// Nothing here logs them, and errors are logged by class/code only: OAuth error
// descriptions and response bodies are upstream-controlled and could echo a
// token (TC-18).
import {
  OAuthError,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationFull,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import type { Upstream } from '../generated/prisma/client.js';
import { systemClock, type Clock } from '../lib/clock.js';
import {
  PENDING_TTL_MS,
  checkPending,
  expiryFrom,
  isNavigableUrl,
  makeState,
  needsRefresh,
  parsePending,
  upstreamIdFromState,
  type PendingAuth,
} from '../lib/upstreamOAuth.js';

/** Timeout for every OAuth request to an upstream's AS. */
const OAUTH_TIMEOUT_MS = 15_000;

/** Stored in `Upstream.oauthMetadata`. */
interface StoredMetadata {
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  /** RFC 8707 resource indicator, when the upstream's PRM names one. */
  resource?: string;
}

/** Stored in `Upstream.oauthClient`: the DCR result and what it was made for. */
interface StoredClient {
  issuer: string;
  redirectUri: string;
  info: OAuthClientInformationFull;
}

/** The connect flow failed in a way the user can be told about (German). */
export class ConnectError extends Error {
  override name = 'ConnectError';
}

/** The upstream's AS refused our refresh token: the user has to reconnect. */
export class ReconnectRequired extends Error {
  constructor() {
    super('upstream needs reconnect');
  }
  override name = 'ReconnectRequired';
}

/** Refresh failed for a reason that is not the AS saying no (network, 5xx). */
export class RefreshUnavailable extends Error {
  constructor() {
    super('upstream token refresh unavailable');
  }
  override name = 'RefreshUnavailable';
}

/** Short, secret-free description of an error for the log. */
export function errorTag(e: unknown): string {
  if (e instanceof OAuthError) return `OAuthError(${e.code})`;
  if (e && typeof e === 'object') {
    const name = (e as { name?: unknown }).name;
    const code = (e as { code?: unknown }).code;
    return `${typeof name === 'string' ? name : 'Error'}${typeof code === 'string' || typeof code === 'number' ? `(${code})` : ''}`;
  }
  return typeof e;
}

/** fetch for OAuth traffic: a timeout, and no redirects on POST (a redirect
 * would replay a body carrying a code, verifier or refresh token elsewhere).
 *
 * The response is re-wrapped in the CURRENT global `Response`: `@hono/node-server`
 * swaps `globalThis.Response` for its own class (see mcp/mount.ts, isAuthInfo),
 * and the SDK's `parseErrorResponse` checks `input instanceof Response`. A
 * native fetch Response fails that check, so every token-endpoint error would
 * parse as `server_error` and a rejected refresh would never be recognised as
 * "reconnect needed". */
const oauthFetch: FetchLike = async (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const timeout = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  const res = await fetch(input, {
    ...init,
    redirect: method === 'GET' ? 'follow' : 'error',
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
};

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Only the AS rejecting the grant/client means "reconnect"; anything else
 * (server_error, temporarily_unavailable, network) is transient. */
const RECONNECT_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope', 'access_denied']);

/** Step 1 (POST /api/upstreams/:id/connect): discovery, DCR if needed, PKCE.
 * Stores the pending flow and returns the URL to send the browser to. */
export async function startConnect(row: Upstream, redirectUri: string, clock: Clock = systemClock): Promise<string> {
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(row.url, { fetchFn: oauthFetch });
  } catch (e) {
    console.warn(`upstream ${row.id}: OAuth discovery failed: ${errorTag(e)}`);
    throw new ConnectError('Der Upstream ist nicht erreichbar oder bietet keine OAuth-Anmeldung an.');
  }
  const metadata = info.authorizationServerMetadata;
  if (!metadata) throw new ConnectError('Der Upstream bietet keine OAuth-Anmeldung an.');

  // RFC 9728 §3.3: the protected-resource document must describe THIS server.
  // A resource on another origin is refused rather than used as an audience.
  let resource: string | undefined;
  const prmResource = info.resourceMetadata?.resource;
  if (prmResource) {
    let same = false;
    try {
      same = new URL(prmResource).origin === new URL(row.url).origin;
    } catch {
      same = false;
    }
    if (!same) throw new ConnectError('Der Upstream meldet eine fremde Ressource; Verbindung abgelehnt.');
    resource = prmResource;
  }

  let client = parseJson<StoredClient>(row.oauthClient);
  if (!client || client.issuer !== metadata.issuer || client.redirectUri !== redirectUri || !client.info?.client_id) {
    if (!metadata.registration_endpoint) {
      throw new ConnectError('Der Upstream unterstützt keine automatische Client-Registrierung.');
    }
    try {
      const full = await registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: 'xitl',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        fetchFn: oauthFetch,
      });
      client = { issuer: metadata.issuer, redirectUri, info: full };
    } catch (e) {
      console.warn(`upstream ${row.id}: client registration failed: ${errorTag(e)}`);
      throw new ConnectError('Die Registrierung beim Upstream ist fehlgeschlagen.');
    }
  }

  const scopes = info.resourceMetadata?.scopes_supported;
  const scope = scopes && scopes.length > 0 ? scopes.join(' ') : undefined;
  const state = makeState(row.id);
  let started: Awaited<ReturnType<typeof startAuthorization>>;
  try {
    started = await startAuthorization(info.authorizationServerUrl, {
      metadata,
      clientInformation: client.info,
      redirectUrl: redirectUri,
      scope,
      state,
      resource,
    });
  } catch (e) {
    console.warn(`upstream ${row.id}: authorization start failed: ${errorTag(e)}`);
    throw new ConnectError('Der Upstream unterstützt die nötige Anmeldung (Code + PKCE) nicht.');
  }
  const authorizationUrl = started.authorizationUrl.href;
  if (!isNavigableUrl(authorizationUrl)) throw new ConnectError('Der Upstream nennt eine ungültige Anmeldeadresse.');

  const pending: PendingAuth = {
    state,
    codeVerifier: started.codeVerifier,
    redirectUri,
    expiresAt: new Date(clock.now().getTime() + PENDING_TTL_MS).toISOString(),
  };
  const stored: StoredMetadata = { authorizationServerUrl: info.authorizationServerUrl, metadata, resource };
  const res = await prisma.upstream.updateMany({
    // url/auth in the condition: if the user edited the upstream meanwhile, the
    // registration was made for something else; refuse.
    where: { id: row.id, userId: row.userId, url: row.url, auth: 'OAUTH' },
    data: { pendingAuth: JSON.stringify(pending), oauthClient: JSON.stringify(client), oauthMetadata: JSON.stringify(stored) },
  });
  if (res.count !== 1) throw new ConnectError('Der Upstream wurde inzwischen geändert. Bitte noch einmal versuchen.');
  return authorizationUrl;
}

export type FinishResult =
  | { kind: 'bad'; message: string }
  | { kind: 'connected'; upstreamId: number }
  | { kind: 'failed'; upstreamId: number; reason: 'abgelehnt' | 'fehler' };

/** Step 2 (GET /api/upstreams/oauth/callback, as the logged-in user). The state
 * must name one of THIS user's upstreams and match its pending flow exactly;
 * it is consumed before the code is redeemed (single use). */
export async function finishConnect(
  userId: number,
  query: { state?: string; code?: string; iss?: string; error?: string },
  clock: Clock = systemClock,
): Promise<FinishResult> {
  const bad = (message = 'Diese Anmeldung ist ungültig oder schon verwendet.') => ({ kind: 'bad' as const, message });
  const id = upstreamIdFromState(query.state);
  if (id === null || !query.state) return bad();

  const row = await prisma.upstream.findFirst({ where: { id, userId } });
  if (!row || row.auth !== 'OAUTH') return bad();
  const pending = parsePending(row.pendingAuth);
  const check = checkPending(pending, query.state, clock.now());
  if (check === 'missing' || check === 'mismatch' || !pending) return bad();

  // Consume it: only one callback can win, conditional on the exact value read.
  const consumed = await prisma.upstream.updateMany({
    where: { id, userId, pendingAuth: row.pendingAuth },
    data: { pendingAuth: null },
  });
  if (consumed.count !== 1) return bad();
  if (check === 'expired') return bad('Die Anmeldung ist abgelaufen. Bitte noch einmal verbinden.');

  if (query.error) return { kind: 'failed', upstreamId: id, reason: 'abgelehnt' };
  if (!query.code) return bad();

  const meta = parseJson<StoredMetadata>(row.oauthMetadata);
  const client = parseJson<StoredClient>(row.oauthClient);
  if (!meta || !client) return { kind: 'failed', upstreamId: id, reason: 'fehler' };

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeAuthorization(meta.authorizationServerUrl, {
      metadata: meta.metadata,
      clientInformation: client.info,
      authorizationCode: query.code,
      iss: query.iss,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      resource: meta.resource,
      fetchFn: oauthFetch,
    });
  } catch (e) {
    console.warn(`upstream ${id}: code exchange failed: ${errorTag(e)}`);
    return { kind: 'failed', upstreamId: id, reason: 'fehler' };
  }
  if (!tokens.access_token || (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) {
    console.warn(`upstream ${id}: unusable token response (type ${tokens.token_type ? 'non-bearer' : 'missing token'})`);
    return { kind: 'failed', upstreamId: id, reason: 'fehler' };
  }

  const saved = await prisma.upstream.updateMany({
    where: { id, userId, url: row.url, auth: 'OAUTH' },
    data: {
      status: 'CONNECTED',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiryFrom(tokens.expires_in, clock.now()),
    },
  });
  if (saved.count !== 1) return { kind: 'failed', upstreamId: id, reason: 'fehler' };
  console.log(`upstream ${id}: connected`);
  return { kind: 'connected', upstreamId: id };
}

/** Drop the tokens and ask the user to reconnect (TC-17). Keeps the client
 * registration and metadata, which a reconnect reuses. */
export async function markNeedsReconnect(id: number, userId: number): Promise<void> {
  await prisma.upstream.updateMany({
    where: { id, userId, auth: 'OAUTH' },
    data: { status: 'NEEDS_RECONNECT', accessToken: null, refreshToken: null, tokenExpiresAt: null },
  });
  console.warn(`upstream ${id}: needs reconnect`);
}

// One refresh per upstream at a time (single replica, ADR-0002): two proxied
// calls racing with a rotating refresh token must not both spend it.
const inflight = new Map<number, Promise<Upstream>>();

/**
 * Returns the row with a usable access token, refreshing if needed.
 * - `force` (after a 401): refresh unless someone else already replaced
 *   `failedToken` meanwhile.
 * - otherwise: refresh only if expired / within 60 s of expiry.
 * Throws ReconnectRequired (and marks the row) when the AS refuses, and
 * RefreshUnavailable on transient failures (tokens kept).
 */
export function refreshUpstreamTokens(
  row: Upstream,
  opts: { clock?: Clock; force?: boolean; failedToken?: string | null } = {},
): Promise<Upstream> {
  const running = inflight.get(row.id);
  if (running) return running;
  const clock = opts.clock ?? systemClock;
  const p = (async () => {
    const fresh = await prisma.upstream.findFirst({ where: { id: row.id, userId: row.userId } });
    if (!fresh || fresh.auth !== 'OAUTH' || fresh.status !== 'CONNECTED' || !fresh.accessToken) throw new ReconnectRequired();
    const alreadyDone = opts.force
      ? fresh.accessToken !== opts.failedToken
      : !needsRefresh(fresh.tokenExpiresAt, clock.now());
    if (alreadyDone) return fresh;

    const meta = parseJson<StoredMetadata>(fresh.oauthMetadata);
    const client = parseJson<StoredClient>(fresh.oauthClient);
    if (!fresh.refreshToken || !meta || !client) {
      await markNeedsReconnect(fresh.id, fresh.userId);
      throw new ReconnectRequired();
    }

    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(meta.authorizationServerUrl, {
        metadata: meta.metadata,
        clientInformation: client.info,
        refreshToken: fresh.refreshToken,
        resource: meta.resource,
        fetchFn: oauthFetch,
      });
    } catch (e) {
      if (e instanceof OAuthError && RECONNECT_CODES.has(String(e.code))) {
        console.warn(`upstream ${fresh.id}: refresh rejected: ${errorTag(e)}`);
        await markNeedsReconnect(fresh.id, fresh.userId);
        throw new ReconnectRequired();
      }
      console.warn(`upstream ${fresh.id}: refresh failed: ${errorTag(e)}`);
      throw new RefreshUnavailable();
    }
    if (!tokens.access_token) {
      await markNeedsReconnect(fresh.id, fresh.userId);
      throw new ReconnectRequired();
    }

    const res = await prisma.upstream.updateMany({
      // Only replace the token we refreshed: a concurrent reconnect wins.
      where: { id: fresh.id, userId: fresh.userId, accessToken: fresh.accessToken, status: 'CONNECTED' },
      data: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? fresh.refreshToken,
        tokenExpiresAt: expiryFrom(tokens.expires_in, clock.now()),
      },
    });
    const after = await prisma.upstream.findFirst({ where: { id: fresh.id, userId: fresh.userId } });
    if (!after || after.status !== 'CONNECTED' || !after.accessToken) throw new ReconnectRequired();
    if (res.count === 1) console.log(`upstream ${fresh.id}: token refreshed`);
    return after;
  })().finally(() => inflight.delete(row.id));
  inflight.set(row.id, p);
  return p;
}
