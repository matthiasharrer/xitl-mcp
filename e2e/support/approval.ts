// Helpers for the approval cases (TC-27…37): an ASK upstream on the fake, held
// calls started without awaiting, polling the user's pending list, deciding,
// and a raw SSE reader. The server under test runs with APPROVAL_TIMEOUT_MS
// (paths.ts), so an undecided call resolves within a few seconds.
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { BASE_URL } from './paths.js';
import { MATTHIAS, dbAll, uniq } from './db.js';
import { MCP_HEADERS, runOAuthFlow } from './mcpClient.js';
import { callTool, connectedUpstream } from './upstream.js';

export interface Pending {
  id: string;
  clientName: string;
  upstream: { id: number; slug: string; name: string };
  tool: string;
  arguments: unknown;
  rulePath: string;
  expiresAt: string;
  remainingMs: number;
  snoozable: boolean;
}

/** A connected upstream with default ASK, tools known (first list = acknowledged),
 * and one MCP client of `user`. */
export async function askUpstream(request: APIRequestContext, prefix: string, overrides: Record<string, unknown> = {}, user = MATTHIAS) {
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', ...overrides }, user);
  const refreshed = await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user });
  expect(refreshed.status()).toBe(200);
  const client = await runOAuthFlow(request, uniq(`Client ${prefix}`), user);
  const clientName = dbAll('select name from McpClient where clientId = ?', client.clientId)[0].name as string;
  return { up, token: client.accessToken, clientId: client.clientId, clientName };
}

/** Starts a tools/call and does NOT await it. */
export function startCall(request: APIRequestContext, slug: string, token: string, name: string, args: Record<string, unknown> = {}) {
  return callTool(request, slug, token, name, args);
}

export async function pendingList(request: APIRequestContext, user = MATTHIAS): Promise<Pending[]> {
  const res = await request.get('/api/approvals', { headers: user });
  expect(res.status()).toBe(200);
  return res.json();
}

/** Waits until the user has a pending call for this upstream + tool. */
export async function waitPending(request: APIRequestContext, upstreamId: number, tool: string, user = MATTHIAS): Promise<Pending> {
  let found: Pending | undefined;
  await expect
    .poll(async () => {
      found = (await pendingList(request, user)).find((p) => p.upstream.id === upstreamId && p.tool === tool);
      return !!found;
    }, { timeout: 4000, intervals: [50, 100, 200] })
    .toBe(true);
  return found!;
}

export function decide(request: APIRequestContext, id: string, data: Record<string, unknown>, user = MATTHIAS) {
  return request.post(`/api/approvals/${id}`, { headers: user, data: { via: 'page', ...data } });
}

export const lastAudit = (upstreamId: number) =>
  dbAll('select * from AuditEntry where upstreamId = ? order by id desc limit 1', upstreamId)[0];

/** Opens GET /api/approvals/stream as `user` and collects events until close(). */
export async function openStream(user: Record<string, string>) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE_URL}/api/approvals/stream`, { headers: user, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (event) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    async close() {
      ctrl.abort();
      await done;
    },
  };
}

/** A raw MCP tools/call over fetch that the test can abort (client hang-up). */
export function abortableCall(slug: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const ctrl = new AbortController();
  const done = fetch(`${BASE_URL}/mcp/${slug}`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: ctrl.signal,
  })
    .then((r) => r.text())
    .catch(() => 'aborted');
  return { abort: () => ctrl.abort(), done };
}
