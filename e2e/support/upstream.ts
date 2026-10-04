// Helpers for the upstream-connect and proxy cases (TC-15…26): tenants on the
// fake upstream, the connect flow driven over HTTP, MCP calls.
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { FAKE_UPSTREAM } from './paths.js';
import { createUpstream, MATTHIAS } from './db.js';
import { parseRpc, postMcp } from './mcpClient.js';

let n = 0;
/** A fresh tenant on the fake upstream: its own AS, tools, counters, tokens. */
export const newTenant = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(++n).toString(36)}`;
export const fakeMcpUrl = (tenant: string) => `${FAKE_UPSTREAM}/t/${tenant}/mcp`;

export async function fakeControl(request: APIRequestContext, tenant: string, what: 'config' | 'tools' | 'expire-access', data: unknown = {}) {
  const res = await request.post(`${FAKE_UPSTREAM}/control/t/${tenant}/${what}`, { data });
  expect(res.status()).toBe(200);
}

export interface FakeState {
  calls: Record<string, number>;
  refreshCount: number;
  mcpRequests: number;
  authSeen: string[];
  tokens: string[];
}
export async function fakeState(request: APIRequestContext, tenant: string): Promise<FakeState> {
  return (await request.get(`${FAKE_UPSTREAM}/control/t/${tenant}/state`)).json();
}

/** Starts the connect flow as `user` and lets the fake AS approve it. Returns
 * the callback URL (not yet visited). */
export async function startConnect(request: APIRequestContext, upstreamId: number, user = MATTHIAS): Promise<string> {
  const res = await request.post(`/api/upstreams/${upstreamId}/connect`, { headers: user });
  expect(res.status(), await res.text()).toBe(200);
  const { authorizationUrl } = await res.json();
  const approve = await request.get(authorizationUrl, { maxRedirects: 0 });
  expect(approve.status()).toBe(302);
  return approve.headers()['location']!;
}

/** Full connect flow over HTTP as `user`; expects success. */
export async function connectViaApi(request: APIRequestContext, upstreamId: number, user = MATTHIAS) {
  const callback = await startConnect(request, upstreamId, user);
  const done = await request.get(callback, { headers: user, maxRedirects: 0 });
  expect(done.status()).toBe(302);
  expect(done.headers()['location']).toBe(`/#/einstellungen?verbunden=${upstreamId}`);
}

/** An OAUTH upstream on a fresh tenant, connected. */
export async function connectedUpstream(
  request: APIRequestContext,
  prefix: string,
  overrides: Record<string, unknown> = {},
  user = MATTHIAS,
  before?: (tenant: string) => Promise<void>,
) {
  const tenant = newTenant(prefix);
  const up = await createUpstream(request, user, { url: fakeMcpUrl(tenant), ...overrides });
  if (before) await before(tenant);
  await connectViaApi(request, up.id, user);
  return { ...up, tenant };
}

let rpcId = 100;
export async function mcp(request: APIRequestContext, slug: string, token: string, method: string, params: unknown = {}) {
  const res = await postMcp(request, slug, token, { jsonrpc: '2.0', id: ++rpcId, method, params });
  expect(res.status()).toBe(200);
  return parseRpc(res);
}

export const listTools = async (request: APIRequestContext, slug: string, token: string) =>
  (await mcp(request, slug, token, 'tools/list')).result.tools as { name: string; description?: string; inputSchema: unknown; annotations?: unknown }[];

export const callTool = async (request: APIRequestContext, slug: string, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await mcp(request, slug, token, 'tools/call', { name, arguments: args })).result as { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };
