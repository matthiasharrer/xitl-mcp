// ADR-0040 (TC-252…TC-265, unit): a forwarded call to an upstream with
// sessionParam runs in the kept upstream session behind its handle. Against a stateful fake upstream over
// real HTTP (Streamable HTTP, sessions like Playwright MCP: per-session state,
// 404 for an unknown session, DELETE ends it).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const findFirst = vi.fn();
const updateMany = vi.fn();
vi.mock('../db.js', () => ({ prisma: { upstream: { findFirst, updateMany } } }));
const { withUpstream, upstreamSessions, isHandleShaped, newHandle, UpstreamPaused } = await import('./connection.js');
const { UPSTREAM_SESSION_IDLE_MS } = await import('../lib/limits.js');

// ---- the fake upstream ----------------------------------------------------------

interface Seen {
  method: string;
  rpc: string | null;
  sessionId: string | null;
  header: string | null;
}
const seen: Seen[] = [];
const sessions = new Map<string, { value: string | null }>();
let nextId = 0;
/** The upstream issues session ids it immediately forgets. */
let forgetful = false;

function rpcResult(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? null;
    const msg = body ? (JSON.parse(body) as { id?: unknown; method?: string; params?: { name?: string; arguments?: { value?: string } } }) : null;
    seen.push({ method: req.method!, rpc: msg?.method ?? null, sessionId, header: (req.headers['x-key'] as string | undefined) ?? null });
    if (req.method === 'GET') return res.writeHead(405).end();
    if (req.method === 'DELETE') {
      if (sessionId) sessions.delete(sessionId);
      return res.writeHead(200).end();
    }
    if (msg?.method === 'initialize') {
      const id = `sess-${++nextId}`;
      if (!forgetful) sessions.set(id, { value: null });
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
      return res.end(rpcResult(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }));
    }
    if (!sessionId || !sessions.has(sessionId)) return res.writeHead(sessionId ? 404 : 400).end('Session not found');
    if (msg?.method === 'notifications/initialized') return res.writeHead(202).end();
    if (msg?.method === 'tools/call') {
      const state = sessions.get(sessionId)!;
      if (msg.params?.name === 'fail') {
        res.writeHead(500);
        return res.end('boom');
      }
      if (msg.params?.name === 'set') state.value = msg.params.arguments?.value ?? null;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(rpcResult(msg.id, { content: [{ type: 'text', text: String(state.value) }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(rpcResult(msg?.id, {}));
  });
});

let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// ---- helpers --------------------------------------------------------------------

let now = new Date('2026-11-06T12:00:00Z');
const clock = { now: () => now } as never;
const row = (over: Record<string, unknown> = {}) => ({
  id: 7, userId: 1, auth: 'HEADER', status: 'CONNECTED', url, sessionParam: true,
  accessToken: null, refreshToken: null, headerName: 'X-Key', headerValue: 'k1',
  tokenExpiresAt: null, instructions: null, lastFailureAt: null, allowInternal: true, pausedAt: null, ...over,
});

type Outcome = { handle: string; kind: string };
/** One forwarded `tools/call`, as server.ts forward() does it. `client`
 * absent = a one-shot connection (lists, instructions). */
async function call(tool: 'set' | 'get' | 'fail', opts: { client?: number; handle?: string | null; value?: string } = {}) {
  let outcome: Outcome | null = null;
  const text = await withUpstream(
    7,
    1,
    async ({ client }) => {
      const r = await client.callTool({ name: tool, arguments: tool === 'set' ? { value: opts.value ?? 'x' } : {} });
      return (r.content as { text: string }[])[0]!.text;
    },
    {
      clock,
      timeoutMs: 5000,
      ...(opts.client !== undefined ? { kept: { mcpClientId: opts.client, handle: opts.handle ?? null }, onSession: (o: Outcome) => (outcome = o) } : {}),
    },
  );
  return { text, outcome: outcome as Outcome | null };
}
const inits = () => seen.filter((s) => s.rpc === 'initialize').length;
const deletes = () => seen.filter((s) => s.method === 'DELETE');
/** closeHttp after a discard may run in the background. */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  seen.length = 0;
  sessions.clear();
  nextId = 0;
  forgetful = false;
  now = new Date('2026-11-06T12:00:00Z');
  findFirst.mockReset().mockResolvedValue(row());
  updateMany.mockReset().mockResolvedValue({ count: 1 });
});
afterEach(async () => {
  upstreamSessions.reset();
  await settle();
});

// ---- cases ----------------------------------------------------------------------

describe('kept upstream sessions by handle (ADR-0040)', () => {
  test('TC-252: no handle -> new session under a fresh handle; with it the state survives (one initialize)', async () => {
    const first = await call('set', { client: 3, value: 'example.com' });
    expect(first.outcome?.kind).toBe('new');
    expect(isHandleShaped(first.outcome?.handle)).toBe(true);
    const again = await call('get', { client: 3, handle: first.outcome!.handle });
    expect(again).toEqual({ text: 'example.com', outcome: { handle: first.outcome!.handle, kind: 'kept' } });
    expect(inits()).toBe(1);
    expect(new Set(seen.filter((s) => s.rpc === 'tools/call').map((s) => s.sessionId))).toEqual(new Set(['sess-1']));
    expect(deletes()).toHaveLength(0);
  });

  test('TC-253: one-shot connections end their session (DELETE) only on an upstream with sessionParam', async () => {
    await call('set', { value: 'v' });
    expect((await call('get')).text).toBe('null');
    await settle();
    expect(deletes().map((d) => d.sessionId)).toEqual(['sess-1', 'sess-2']);
    seen.length = 0;
    findFirst.mockResolvedValue(row({ sessionParam: false }));
    await call('get');
    await settle();
    expect(deletes()).toHaveLength(0); // unmarked: exactly as before
  });

  test('TC-254: handles are separate; another client\'s handle is not found (new session, same answer as unknown)', async () => {
    const a = (await call('set', { client: 3, value: 'a' })).outcome!.handle;
    const b = (await call('set', { client: 3, value: 'b' })).outcome!.handle;
    expect(a).not.toBe(b);
    expect((await call('get', { client: 3, handle: a })).text).toBe('a');
    expect((await call('get', { client: 3, handle: b })).text).toBe('b');
    const foreign = await call('get', { client: 4, handle: a });
    expect(foreign.text).toBe('null');
    expect(foreign.outcome?.kind).toBe('replaced');
    expect(foreign.outcome?.handle).not.toBe(a);
    expect((await call('get', { client: 3, handle: a })).text).toBe('a'); // untouched
  });

  test('TC-255: a kept connection opens no GET stream (Playwright heartbeat)', async () => {
    const h = (await call('set', { client: 3 })).outcome!.handle;
    await call('get', { client: 3, handle: h });
    await settle();
    expect(seen.filter((s) => s.method === 'GET')).toHaveLength(0);
  });

  test('TC-256: session gone upstream -> reopened once under the SAME handle, call repeated, kind restarted', async () => {
    const h = (await call('set', { client: 3, value: 'old' })).outcome!.handle;
    sessions.clear(); // upstream restarted / timed out
    expect(await call('get', { client: 3, handle: h })).toEqual({ text: 'null', outcome: { handle: h, kind: 'restarted' } });
    expect(inits()).toBe(2);
    expect(await call('get', { client: 3, handle: h })).toEqual({ text: 'null', outcome: { handle: h, kind: 'kept' } });
    expect(inits()).toBe(2);
  });

  test('TC-257: a 404 on a just-opened session is not retried, and nothing is kept or reported', async () => {
    forgetful = true;
    let outcome: Outcome | null = null;
    await expect(
      withUpstream(7, 1, async ({ client }) => client.callTool({ name: 'get', arguments: {} }), { clock, timeoutMs: 5000, kept: { mcpClientId: 3, handle: null }, onSession: (o) => (outcome = o) }),
    ).rejects.toThrow();
    expect(outcome).toBeNull();
    expect(inits()).toBe(1);
    expect(upstreamSessions.size).toBe(0);
  });

  test('TC-258: end() ends the session (DELETE) for its own client only; the handle is then unknown', async () => {
    const h = (await call('set', { client: 3, value: 'v' })).outcome!.handle;
    expect(await upstreamSessions.end(1, 7, 4, h)).toBe(false); // another client
    expect(deletes()).toHaveLength(0);
    expect(await upstreamSessions.end(1, 7, 3, h)).toBe(true);
    expect(deletes().map((d) => d.sessionId)).toEqual(['sess-1']);
    const after = await call('get', { client: 3, handle: h });
    expect(after.text).toBe('null');
    expect(after.outcome?.kind).toBe('replaced');
  });

  test('TC-259: idle for UPSTREAM_SESSION_IDLE_MS -> ended (DELETE) on the next sweep', async () => {
    await call('set', { client: 3, value: 'v' });
    now = new Date(now.getTime() + UPSTREAM_SESSION_IDLE_MS - 1);
    upstreamSessions.sweep(now);
    await settle();
    expect(deletes()).toHaveLength(0);
    now = new Date(now.getTime() + 1);
    upstreamSessions.sweep(now);
    await settle();
    expect(deletes().map((d) => d.sessionId)).toEqual(['sess-1']);
    expect(upstreamSessions.size).toBe(0);
  });

  test('TC-260: credentials come from the row re-read for each call', async () => {
    const h = (await call('set', { client: 3 })).outcome!.handle;
    findFirst.mockResolvedValue(row({ headerValue: 'k2' }));
    await call('get', { client: 3, handle: h });
    expect(seen.filter((s) => s.rpc === 'tools/call').map((c) => c.header)).toEqual(['k1', 'k2']);
    expect(inits()).toBe(1);
  });

  test('TC-261: a changed URL drops the kept session without contacting it; endUpstream drops all', async () => {
    const h = (await call('set', { client: 3, value: 'v' })).outcome!.handle;
    findFirst.mockResolvedValue(row({ url: url.replace('/mcp', '/mcp?v=2') }));
    const r = await call('get', { client: 3, handle: h });
    expect(r.text).toBe('null');
    expect(r.outcome?.kind).toBe('replaced');
    await settle();
    expect(deletes()).toHaveLength(0);
    upstreamSessions.endUpstream(1, 7);
    await settle();
    expect(upstreamSessions.size).toBe(0);
    expect(deletes()).toHaveLength(0);
  });

  test('TC-262: concurrent calls with one handle share the connection', async () => {
    const h = (await call('set', { client: 3, value: 'p' })).outcome!.handle;
    const all = await Promise.all([call('get', { client: 3, handle: h }), call('get', { client: 3, handle: h }), call('get', { client: 3, handle: h })]);
    expect(all.map((r) => r.text)).toEqual(['p', 'p', 'p']);
    expect(inits()).toBe(1);
  });

  test('TC-263: a paused upstream is refused before its kept session is used', async () => {
    const h = (await call('set', { client: 3 })).outcome!.handle;
    const before = seen.length;
    findFirst.mockResolvedValue(row({ pausedAt: now }));
    await expect(call('get', { client: 3, handle: h })).rejects.toBeInstanceOf(UpstreamPaused);
    expect(seen.length).toBe(before);
  });

  test('TC-264: a call that fails on a session opened for it ends that session; nothing is reported', async () => {
    let outcome: Outcome | null = null;
    await expect(
      withUpstream(7, 1, async ({ client }) => client.callTool({ name: 'fail', arguments: {} }), { clock, timeoutMs: 5000, kept: { mcpClientId: 3, handle: null }, onSession: (o) => (outcome = o) }),
    ).rejects.toThrow();
    expect(outcome).toBeNull();
    expect(upstreamSessions.size).toBe(0);
    expect(deletes().map((d) => d.sessionId)).toEqual(['sess-1']);
  });
});

describe('isHandleShaped', () => {
  test('only 6 base64url characters (ADR-0040 amendment 2026-11-07)', () => {
    expect(isHandleShaped('AAAAAA')).toBe(true);
    expect(isHandleShaped('A-_a9z')).toBe(true);
    for (const v of ['', 'short', 'AAAAAAA', 'AAAA=A', 'AAAAAAAAAAAAAAAAAAAAAA', 42, null, undefined, {}, ['AAAAAA']]) expect(isHandleShaped(v)).toBe(false);
  });
  test('newHandle mints handle-shaped, varying values', () => {
    const many = new Set(Array.from({ length: 200 }, () => newHandle()));
    for (const h of many) expect(isHandleShaped(h)).toBe(true);
    expect(many.size).toBeGreaterThan(195);
  });
});

describe('handle collisions (ADR-0040 amendment 2026-11-07)', () => {
  test('TC-279: freshHandle skips handles of open sessions of this user + upstream, not of others', async () => {
    const first = await call('set', { client: 3, value: 'a' });
    const taken = first.outcome!.handle;
    const seq = (...hs: string[]) => () => hs.shift()!;
    expect(upstreamSessions.freshHandle(1, 7, seq(taken, taken, 'BBBBBB'))).toBe('BBBBBB');
    // Another upstream or user: the same handle is free there (the key differs).
    expect(upstreamSessions.freshHandle(1, 8, seq(taken))).toBe(taken);
    expect(upstreamSessions.freshHandle(2, 7, seq(taken))).toBe(taken);
  });

  test('TC-280: open() never hands another client a session under the same key (fail closed)', async () => {
    const first = await call('set', { client: 3, value: 'a' });
    const key = `1:7:${first.outcome!.handle}`;
    const opener = vi.fn();
    await expect(
      upstreamSessions.open(key, { userId: 1, upstreamId: 7, mcpClientId: 4, handle: first.outcome!.handle }, opener, now),
    ).rejects.toThrow('collision');
    expect(opener).not.toHaveBeenCalled();
    // The owner still gets it.
    const own = await upstreamSessions.open(key, { userId: 1, upstreamId: 7, mcpClientId: 3, handle: first.outcome!.handle }, opener, now);
    expect(own.mcpClientId).toBe(3);
    expect(opener).not.toHaveBeenCalled();
  });
});
