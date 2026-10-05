// Unbounded tables (TC-88, TC-89): never-approved DCR clients and KnownTool
// rows of tools that left an upstream's list. Rows are written straight into
// the e2e DB with old timestamps; the real limits apply (24 h, 100 clients,
// 1000 tools), no env knobs.
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { MATTHIAS, createUpstream, dbAll, dbBatch, dbRun } from '../support/db.js';
import { FAKE_HEADER_NAME, FAKE_HEADER_SECRET } from '../support/paths.js';
import { fakeControl, fakeMcpUrl, newTenant } from '../support/upstream.js';
import { AUTHORIZE, authorizeParams, pkcePair, registerMcpClient } from '../support/mcpClient.js';

const HOUR = 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().replace('Z', '+00:00');
const ago = (ms: number) => iso(new Date(Date.now() - ms));
const rnd = () => crypto.randomBytes(12).toString('base64url');

const exists = (clientId: string) => dbAll('select id from McpClient where clientId = ?', clientId).length === 1;
const unboundCount = () => dbAll("select count(*) n from McpClient where kind = 'OAUTH' and userId is null")[0].n as number;
const boundIds = () => dbAll("select id from McpClient where userId is not null order by id").map((r) => r.id as number);

async function matthiasId(request: import('@playwright/test').APIRequestContext): Promise<number> {
  await request.get('/api/me', { headers: MATTHIAS });
  return dbAll('select id from User where username = ?', 'matthias')[0].id;
}

/** Inserts a client row; returns its clientId. */
function insertClient(opts: { createdAt: string; kind?: 'OAUTH' | 'TOKEN'; userId?: number | null; upstreamId?: number | null }): string {
  const clientId = `tc88-${rnd()}`;
  const kind = opts.kind ?? 'OAUTH';
  dbRun(
    'insert into McpClient (clientId, name, redirectUris, kind, userId, upstreamId, allUpstreams, tokenHash, tokenPrefix, createdAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    clientId,
    'TC-88',
    JSON.stringify(['https://example.com/callback']),
    kind,
    opts.userId ?? null,
    opts.upstreamId ?? null,
    0,
    kind === 'TOKEN' ? crypto.randomBytes(32).toString('hex') : null,
    kind === 'TOKEN' ? 'xitl_tc88' : null,
    opts.createdAt,
  );
  return clientId;
}

test.describe('TC-88 never-approved DCR clients are cleaned up', () => {
  test('a registration removes unbound clients older than 24 h, and nothing else', async ({ request }) => {
    const uid = await matthiasId(request);
    const up = await createUpstream(request, MATTHIAS);
    const stale = insertClient({ createdAt: ago(25 * HOUR) });
    const young = insertClient({ createdAt: ago(1 * HOUR) });
    const bound = insertClient({ createdAt: ago(25 * HOUR), userId: uid });
    const token = insertClient({ createdAt: ago(25 * HOUR), kind: 'TOKEN', userId: uid, upstreamId: up.id });

    const fresh = await registerMcpClient(request, 'TC-88 neu');

    expect(exists(stale)).toBe(false);
    expect(exists(young)).toBe(true);
    expect(exists(bound)).toBe(true);
    expect(exists(token)).toBe(true);
    expect(exists(fresh)).toBe(true);

    // A consent request for the pruned client gets the unknown-client page, no 500.
    const consent = await request.get(AUTHORIZE, { params: authorizeParams(stale, pkcePair().challenge), headers: MATTHIAS, maxRedirects: 0 });
    expect(consent.status()).toBe(400);
    expect(await consent.text()).toContain('Unbekannter oder abgelaufener client_id-Parameter.');
    // ...and the token endpoint refuses it as a grant error, no 500.
    const tok = await request.post('/mcp/token', {
      form: { grant_type: 'authorization_code', code: 'x', code_verifier: 'y', client_id: stale, redirect_uri: 'https://example.com/callback' },
    });
    expect(tok.status()).toBe(400);
    expect((await tok.json()).error).toBe('invalid_grant');

    for (const id of [young, bound, token, fresh]) dbRun('delete from McpClient where clientId = ?', id);
    await request.delete(`/api/upstreams/${up.id}`, { headers: MATTHIAS });
  });

  test('at most 100 unbound clients: the oldest is evicted, bound clients untouched', async ({ request }) => {
    const uid = await matthiasId(request);
    const bound = insertClient({ createdAt: ago(23.9 * HOUR), userId: uid });
    const boundBefore = boundIds();
    // Fill up to the cap (at least one row): one clearly oldest, the rest younger.
    const fill = Math.max(1, 100 - unboundCount());
    const oldest = insertClient({ createdAt: ago(23 * HOUR) });
    const filler = Array.from({ length: fill - 1 }, () => `tc88-${rnd()}`);
    dbBatch(
      "insert into McpClient (clientId, name, redirectUris, kind, allUpstreams, createdAt) values (?, 'TC-88', '[]', 'OAUTH', 0, ?)",
      filler.map((id) => [id, ago(22 * HOUR)]),
    );
    expect(unboundCount()).toBeGreaterThanOrEqual(100);

    const fresh = await registerMcpClient(request, 'TC-88 Grenze');

    expect(unboundCount()).toBeLessThanOrEqual(100);
    expect(exists(oldest)).toBe(false);
    expect(exists(fresh)).toBe(true);
    expect(boundIds()).toEqual(boundBefore);

    const consent = await request.get(AUTHORIZE, { params: authorizeParams(oldest, pkcePair().challenge), headers: MATTHIAS, maxRedirects: 0 });
    expect(consent.status()).toBe(400);

    dbRun("delete from McpClient where clientId like 'tc88-%'");
    dbRun('delete from McpClient where clientId = ?', fresh);
    expect(exists(bound)).toBe(false);
  });
});

test('TC-89 KnownTool rows per upstream are capped at 1000; current tools stay; a returning tool is new', async ({ request }) => {
  const tenant = newTenant('tc89');
  const up = await createUpstream(request, MATTHIAS, {
    url: fakeMcpUrl(tenant),
    auth: 'HEADER',
    headerName: FAKE_HEADER_NAME,
    headerValue: FAKE_HEADER_SECRET,
  });
  const refresh = async () => expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: MATTHIAS })).status()).toBe(200);
  await refresh();
  const current = dbAll('select name from KnownTool where upstreamId = ?', up.id).map((r) => r.name as string);
  expect(current.length).toBe(3);

  // 1000 tools that left the list, stale_0000 the oldest.
  const base = Date.now() - 48 * HOUR;
  const at = (i: number) => iso(new Date(base + i * 1000));
  dbBatch(
    'insert into KnownTool (upstreamId, name, firstSeenAt, lastSeenAt, acknowledgedAt) values (?, ?, ?, ?, ?)',
    Array.from({ length: 1000 }, (_, i) => [up.id, `stale_${String(i).padStart(4, '0')}`, at(i), at(i), at(i)]),
  );
  await refresh();
  const names = () => new Set(dbAll('select name from KnownTool where upstreamId = ?', up.id).map((r) => r.name as string));
  let left = names();
  expect(left.size).toBe(1000);
  for (const n of current) expect(left.has(n)).toBe(true);
  for (const n of ['stale_0000', 'stale_0001', 'stale_0002']) expect(left.has(n)).toBe(false);
  expect(left.has('stale_0003')).toBe(true);

  // A pruned tool comes back: it is new again (not acknowledged).
  await fakeControl(request, tenant, 'tools', { name: 'stale_0000', description: 'wieder da' });
  await refresh();
  left = names();
  expect(left.size).toBe(1000);
  expect(left.has('stale_0003')).toBe(false);
  expect(dbAll('select acknowledgedAt, changedAt from KnownTool where upstreamId = ? and name = ?', up.id, 'stale_0000')).toEqual([
    { acknowledgedAt: null, changedAt: null },
  ]);

  await request.delete(`/api/upstreams/${up.id}`, { headers: MATTHIAS });
});
