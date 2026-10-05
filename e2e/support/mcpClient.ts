// MCP test client (copied from haushalts-todos' e2e/support/mcpClient.ts,
// adapted to `/mcp/<slug>`, ADR-0014). MCP is OAuth-only (ADR-0012): the
// endpoints accept nothing but a signed access token minted by `/mcp/token`, so
// every spec that calls one runs the real register -> /oauth/authorize (PKCE +
// CSRF, as an Authelia user) -> /mcp/token round trip. The raw MCP_TOKEN is the
// HMAC signing secret, never a bearer.
import crypto from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect } from '@playwright/test';
import { MATTHIAS } from './db.js';

export const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
export const MCP_REDIRECT_URI = 'https://example.com/callback';
export const AUTHORIZE = '/oauth/authorize';

export type Identity = Record<string, string>;

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Registers a client via DCR and returns its client_id. */
export async function registerMcpClient(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/mcp/register', {
    data: { redirect_uris: [MCP_REDIRECT_URI], client_name: name },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).client_id as string;
}

export function authorizeParams(clientId: string, challenge: string, state = 'st-' + crypto.randomBytes(4).toString('hex')) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: MCP_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp',
    state,
  };
}

export async function csrfFrom(consent: APIResponse): Promise<string> {
  return (await consent.text()).match(/name="csrf" value="([^"]*)"/)?.[1] ?? '';
}

/** Exchanges a code for tokens. */
export function exchangeCode(request: APIRequestContext, clientId: string, code: string, verifier: string) {
  return request.post('/mcp/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: MCP_REDIRECT_URI,
    },
  });
}

export interface OAuthResult {
  clientId: string;
  accessToken: string;
  refreshToken: string;
}

/** Full register -> authorize (GET for the CSRF cookie+field, POST allow) ->
 * token round trip as the given Authelia user. */
export async function runOAuthFlow(
  request: APIRequestContext,
  name: string,
  user: Identity = MATTHIAS,
): Promise<OAuthResult> {
  const clientId = await registerMcpClient(request, name);
  const { verifier, challenge } = pkcePair();
  const params = authorizeParams(clientId, challenge);
  const consent = await request.get(AUTHORIZE, { params, headers: user, maxRedirects: 0 });
  expect(consent.status()).toBe(200);
  const csrf = await csrfFrom(consent);
  expect(csrf).not.toBe('');
  const approve = await request.post(AUTHORIZE, {
    form: { ...params, csrf, decision: 'allow' },
    headers: user,
    maxRedirects: 0,
  });
  expect(approve.status()).toBe(302);
  const code = new URL(approve.headers()['location']!).searchParams.get('code')!;
  expect(code).toBeTruthy();

  const token = await exchangeCode(request, clientId, code, verifier);
  expect(token.status()).toBe(200);
  const body = await token.json();
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}

export interface McpRequestOptions {
  /** Sent as `Mcp-Session-Id` (ADR-0016). Omitted = sessionless, the default
   * every older spec relies on. */
  sessionId?: string;
  /** Extra request headers (e.g. a User-Agent or a diagnostic header). */
  headers?: Record<string, string>;
}

function mcpHeaders(token: string | null, opts: McpRequestOptions = {}): Record<string, string> {
  return {
    ...MCP_HEADERS,
    ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.sessionId !== undefined ? { 'Mcp-Session-Id': opts.sessionId } : {}),
    ...opts.headers,
  };
}

/** POSTs one JSON-RPC message to /mcp/<slug> with the given bearer (null = none). */
export function postMcp(request: APIRequestContext, slug: string, token: string | null, body: unknown, opts: McpRequestOptions = {}) {
  return request.post(`/mcp/${slug}`, { headers: mcpHeaders(token, opts), data: body });
}

/** DELETE /mcp/<slug> (ends a session, Streamable HTTP). */
export function deleteMcp(request: APIRequestContext, slug: string, token: string | null, opts: McpRequestOptions = {}) {
  return request.delete(`/mcp/${slug}`, { headers: mcpHeaders(token, opts) });
}

let sessionRpcId = 1000;

/** A 2025-era client that keeps its session: `initialize` (expects an
 * `Mcp-Session-Id` back), then every request carries the id, like the SDK's
 * StreamableHTTPClientTransport. */
export async function openMcpSession(
  request: APIRequestContext,
  slug: string,
  token: string,
  init: { clientInfo?: { name: string; version: string }; protocolVersion?: string; headers?: Record<string, string> } = {},
) {
  const res = await postMcp(
    request,
    slug,
    token,
    {
      ...INITIALIZE,
      params: {
        ...INITIALIZE.params,
        ...(init.protocolVersion ? { protocolVersion: init.protocolVersion } : {}),
        ...(init.clientInfo ? { clientInfo: init.clientInfo } : {}),
      },
    },
    { headers: init.headers },
  );
  expect(res.status()).toBe(200);
  const sessionId = res.headers()['mcp-session-id'];
  expect(sessionId, 'initialize must return Mcp-Session-Id').toBeTruthy();
  const initResult = await parseRpc(res);
  const version: string = initResult.result.protocolVersion;
  const withSession = (headers: Record<string, string> = {}): McpRequestOptions => ({
    sessionId,
    headers: { 'MCP-Protocol-Version': version, ...headers },
  });
  return {
    sessionId: sessionId!,
    initResult,
    /** Raw POST with the session (status not checked). */
    post: (body: unknown, headers?: Record<string, string>) => postMcp(request, slug, token, body, withSession(headers)),
    /** One request; expects 200 and returns the JSON-RPC message. */
    async rpc(method: string, params: unknown = {}, headers?: Record<string, string>) {
      const r = await postMcp(request, slug, token, { jsonrpc: '2.0', id: ++sessionRpcId, method, params }, withSession(headers));
      expect(r.status(), `${method} in session`).toBe(200);
      return parseRpc(r);
    },
    end: () => deleteMcp(request, slug, token, withSession()),
  };
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0.0.0' } },
};
export const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

/** The handler answers either a JSON body or one SSE `data:` frame. */
export async function parseRpc(res: APIResponse): Promise<any> {
  const contentType = res.headers()['content-type'] ?? '';
  const text = await res.text();
  if (contentType.includes('application/json')) return JSON.parse(text);
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data frame in MCP response: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

/** Signs a blob like the server does (independent re-implementation, so the
 * specs can forge tokens: expired, wrong user, unknown client). */
export function forgeBlob(claims: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
