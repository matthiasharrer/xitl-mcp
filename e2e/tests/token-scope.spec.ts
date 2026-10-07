// Access-token scopes (ADR-0018): TC-69…TC-72. Written from the ADRs and
// docs/testing.md. A TOKEN client is for one upstream (upstreamId set) or for
// all upstreams of its user (allUpstreams = 1, upstreamId NULL); any other
// combination is rejected. Own identities per case (support/db.ts); never an
// upstream for anna.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { TS_A, TS_B, TS_REV, TS_SEC, TS_UI, dbAll, dbRun, uniq } from '../support/db.js';
import { INITIALIZE, LIST, postMcp } from '../support/mcpClient.js';
import { BASE_URL } from '../support/paths.js';
import { callTool, connectedUpstream, fakeState, listTools } from '../support/upstream.js';
import { decide, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type User = Record<string, string>;
interface Created {
  client: { id: number; name: string; kind: string; tokenPrefix: string; allUpstreams?: boolean; upstream?: unknown };
  token: string;
}
async function createAllToken(request: APIRequestContext, user: User, name: string): Promise<Created> {
  const res = await request.post('/api/mcp/tokens', { headers: user, data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
async function createOneToken(request: APIRequestContext, upstreamId: number, user: User, name: string): Promise<Created> {
  const res = await request.post(`/api/upstreams/${upstreamId}/tokens`, { headers: user, data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
async function upstreamOf(request: APIRequestContext, prefix: string, user: User, overrides: Record<string, unknown> = {}) {
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Up ${prefix}`), ...overrides }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  return up;
}
const userId = (u: User) => dbAll('select id from User where username = ?', u['Remote-User'])[0].id as number;
const tokenCount = () => dbAll("select count(*) n from McpClient where kind = 'TOKEN'")[0].n as number;
const callsOf = async (request: APIRequestContext, tenant: string) => (await fakeState(request, tenant)).calls;

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: TS_UI });

  test('TC-69 Token für alle Upstreams @390x844: einmalig angezeigt, Befehl zeigt auf /mcp, Liste "Token für alle Upstreams"', async ({ page, request }) => {
    await upstreamOf(request, 'tc69', TS_UI);
    const name = uniq('Claude Code Alle');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/einstellungen');
    await page.getByRole('button', { name: 'Token für alle Upstreams erstellen' }).click();
    const sheet = page.locator('dialog.sheet');
    await expect(sheet.getByRole('heading', { name: 'Token erstellen' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Erstellen' })).toBeDisabled();
    await sheet.getByLabel('Name des Clients').fill(name);
    await sheet.getByRole('button', { name: 'Erstellen' }).click();

    await expect(sheet.getByText('Wird nur jetzt angezeigt.')).toBeVisible();
    const token = (await sheet.getByTestId('token-value').innerText()).trim();
    expect(token).toMatch(/^xitl_[A-Za-z0-9_-]{43}$/);
    const command = (await sheet.getByTestId('token-command').innerText()).trim();
    expect(command).toContain(`${BASE_URL}/mcp `);
    expect(command).not.toMatch(/\/mcp\/[a-z0-9]/);
    expect(command).toContain(`Authorization: Bearer ${token}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await sheet.getByRole('button', { name: 'Fertig' }).click();
    await expect(sheet).toHaveCount(0);

    const row = page.getByRole('list', { name: 'MCP-Clients' }).locator('li.item', { hasText: name });
    await expect(row).toContainText('Token für alle Upstreams');
    expect(await page.content()).not.toContain(token);
    await row.getByRole('link', { name: `${name} öffnen` }).click();
    await expect(page.getByTestId('token-prefix')).toHaveText(`${token.slice(0, 12)}…`);
    expect(await page.content()).not.toContain(token);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    // the token really works on /mcp
    const db = dbAll('select kind, allUpstreams, upstreamId from McpClient where name = ?', name);
    expect(db).toEqual([{ kind: 'TOKEN', allUpstreams: 1, upstreamId: null }]);
    expect((await postMcp(request, null, token, LIST)).status()).toBe(200);
  });
});

test('TC-70 Alle-Upstreams-Token: /mcp (beide Upstreams, Aufruf, ask, Audit) und jeder /mcp/<slug> des Users; fremder Slug -> 404', async ({ request }) => {
  const ua = await upstreamOf(request, 'tc70a', TS_A, { defaultPolicy: 'ALLOW' });
  const ub = await upstreamOf(request, 'tc70b', TS_A, { defaultPolicy: 'ASK' });
  const foreign = await upstreamOf(request, 'tc70f', TS_B, { defaultPolicy: 'ALLOW' });
  const name = uniq('Token TC70');
  const { client, token } = await createAllToken(request, TS_A, name);
  expect(client).toMatchObject({ name, kind: 'TOKEN', allUpstreams: true });
  expect(dbAll('select allUpstreams, upstreamId, userId from McpClient where id = ?', client.id)[0]).toEqual({ allUpstreams: 1, upstreamId: null, userId: userId(TS_A) });

  // /mcp: initialize + both upstreams' prefixed tools
  const init = await postMcp(request, null, token, INITIALIZE);
  expect(init.status()).toBe(200);
  const names = (await listTools(request, null, token)).map((t) => t.name);
  for (const up of [ua, ub]) expect(names).toContain(`${up.slug}_add_item`);
  expect(names.some((n) => n.startsWith(`${foreign.slug}_`))).toBe(false);

  // ALLOW call forwarded to ua only
  const ok = await callTool(request, null, token, `${ua.slug}_add_item`, { item: 'Eier' });
  expect(ok).toEqual({ content: [{ type: 'text', text: 'hinzugefügt: Eier' }] });
  expect((await callsOf(request, ua.tenant)).add_item).toBe(1);
  expect(await callsOf(request, ub.tenant)).toEqual({});
  expect(dbAll('select * from AuditEntry where upstreamId = ? order by id desc limit 1', ua.id)[0]).toMatchObject({ mcpClientId: client.id, endpoint: '/mcp', outcome: 'FORWARDED' });

  // ASK call held; approval names the token client; forwarded after approve
  const held = callTool(request, null, token, `${ub.slug}_add_item`, { item: 'Brot' });
  const p = await waitPending(request, ub.id, 'add_item', TS_A);
  expect(p.clientName).toBe(name);
  expect((await callsOf(request, ub.tenant)).add_item ?? 0).toBe(0);
  expect((await decide(request, p.id, { decision: 'approve' }, TS_A)).status()).toBe(200);
  expect(await held).toEqual({ content: [{ type: 'text', text: 'hinzugefügt: Brot' }] });
  expect((await callsOf(request, ub.tenant)).add_item).toBe(1);
  expect(dbAll('select * from AuditEntry where approvalId = ?', p.id)[0]).toMatchObject({ mcpClientId: client.id, endpoint: '/mcp', outcome: 'FORWARDED', decisionPath: 'policy:upstream-default+approved:page' });

  // every /mcp/<slug> of its user
  for (const up of [ua, ub]) {
    const tools = await listTools(request, up.slug, token);
    expect(tools.map((t) => t.name)).toContain('add_item');
  }
  const single = await callTool(request, ua.slug, token, 'add_item', { item: 'Käse' });
  expect(single.isError).toBeFalsy();
  expect((await callsOf(request, ua.tenant)).add_item).toBe(2);
  expect(dbAll('select * from AuditEntry where upstreamId = ? order by id desc limit 1', ua.id)[0]).toMatchObject({ mcpClientId: client.id, endpoint: `/mcp/${ua.slug}` });

  // another user's slug: 404, nothing reaches their tenant
  const res = await postMcp(request, foreign.slug, token, LIST);
  expect(res.status()).toBe(404);
  const res2 = await postMcp(request, foreign.slug, token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'add_item', arguments: { item: 'x' } } });
  expect(res2.status()).toBe(404);
  // and via the prefix on /mcp
  const viaPrefix = await callTool(request, null, token, `${foreign.slug}_add_item`, { item: 'x' });
  expect(viaPrefix.isError).toBe(true);
  expect(await callsOf(request, foreign.tenant)).toEqual({});
});

test('TC-71 Ein-Upstream-Token nie auf /mcp oder fremdem Slug; inkonsistenter Scope (manipulierte Zeilen) -> 401 überall', async ({ request }) => {
  const ua = await upstreamOf(request, 'tc71a', TS_SEC, { defaultPolicy: 'ALLOW' });
  const ub = await upstreamOf(request, 'tc71b', TS_SEC, { defaultPolicy: 'ALLOW' });
  const probe = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'add_item', arguments: { item: 'x' } } };

  // a one-upstream token: works on its slug, 401 on /mcp and on the user's other slug
  const one = await createOneToken(request, ua.id, TS_SEC, uniq('One TC71'));
  expect(one.client.allUpstreams ?? false).toBe(false);
  expect(dbAll('select allUpstreams, upstreamId from McpClient where id = ?', one.client.id)[0]).toEqual({ allUpstreams: 0, upstreamId: ua.id });
  expect((await postMcp(request, ua.slug, one.token, LIST)).status()).toBe(200);
  for (const slug of [null, ub.slug]) {
    expect((await postMcp(request, slug, one.token, LIST)).status(), String(slug)).toBe(401);
    expect((await postMcp(request, slug, one.token, probe)).status(), String(slug)).toBe(401);
  }

  // tamper 1: allUpstreams=1 while keeping upstreamId
  const both = await createOneToken(request, ua.id, TS_SEC, uniq('Both TC71'));
  expect((await postMcp(request, ua.slug, both.token, LIST)).status()).toBe(200);
  dbRun('update McpClient set allUpstreams = 1 where id = ?', both.client.id);
  expect(dbAll('select allUpstreams, upstreamId from McpClient where id = ?', both.client.id)[0]).toEqual({ allUpstreams: 1, upstreamId: ua.id });
  // tamper 2: neither scope
  const none = await createAllToken(request, TS_SEC, uniq('None TC71'));
  expect((await postMcp(request, null, none.token, LIST)).status()).toBe(200);
  dbRun('update McpClient set allUpstreams = 0, upstreamId = NULL where id = ?', none.client.id);
  expect(dbAll('select allUpstreams, upstreamId from McpClient where id = ?', none.client.id)[0]).toEqual({ allUpstreams: 0, upstreamId: null });

  for (const [label, token] of [['both', both.token], ['none', none.token]] as const) {
    for (const slug of [null, ua.slug, ub.slug]) {
      expect((await postMcp(request, slug, token, LIST)).status(), `${label} ${slug}`).toBe(401);
      expect((await postMcp(request, slug, token, probe)).status(), `${label} ${slug} call`).toBe(401);
    }
  }
  expect(await callsOf(request, ua.tenant)).toEqual({});
  expect(await callsOf(request, ub.tenant)).toEqual({});
});

test('TC-72 POST /api/mcp/tokens: Name 1-100, Sec-Fetch-Guard, Token nur in der Antwort, Widerruf -> 401 und wartender Aufruf +revoked', async ({ request }) => {
  const up = await upstreamOf(request, 'tc72', TS_REV);
  const name = uniq('Token TC72');

  // name validation
  const before = tokenCount();
  for (const bad of [undefined, '', '   ', 'x'.repeat(101), 5, null]) {
    expect((await request.post('/api/mcp/tokens', { headers: TS_REV, data: { name: bad } })).status(), String(bad)).toBe(400);
  }
  expect(tokenCount()).toBe(before);
  // identity required
  expect((await request.post('/api/mcp/tokens', { data: { name: 'x' } })).status()).toBe(401);
  // CSRF guard
  for (const site of ['cross-site', 'same-site']) {
    const res = await request.post('/api/mcp/tokens', { headers: { ...TS_REV, 'Sec-Fetch-Site': site }, data: { name: 'csrf' } });
    expect(res.status(), site).toBe(403);
    expect(tokenCount()).toBe(before);
  }
  expect((await request.post('/api/mcp/tokens', { headers: { ...TS_REV, 'Sec-Fetch-Site': 'same-origin' }, data: { name: 'x'.repeat(100) } })).status()).toBe(201);

  const { client, token } = await createAllToken(request, TS_REV, name);
  expect(token).toMatch(/^xitl_[A-Za-z0-9_-]{43}$/);

  // the token appears only in the creation response
  const list = await request.get('/api/mcp/clients', { headers: TS_REV });
  const text = await list.text();
  expect(text).not.toContain(token);
  const listed = JSON.parse(text).find((c: any) => c.id === client.id);
  expect(listed).toMatchObject({ id: client.id, name, kind: 'TOKEN', allUpstreams: true, tokenPrefix: token.slice(0, 12) });
  expect(listed.upstream ?? null).toBeNull();
  const row = dbAll('select * from McpClient where id = ?', client.id)[0];
  expect(row).toMatchObject({ kind: 'TOKEN', allUpstreams: 1, upstreamId: null, tokenPrefix: token.slice(0, 12) });
  expect(JSON.stringify(row)).not.toContain(token);
  for (const path of ['/api/audit', '/api/approvals', '/api/upstreams']) {
    expect(await (await request.get(path, { headers: TS_REV })).text(), path).not.toContain(token);
  }
  // another user does not see it
  const other = await (await request.get('/api/mcp/clients', { headers: TS_B })).json();
  expect(other.map((c: any) => c.id)).not.toContain(client.id);
  expect((await request.delete(`/api/mcp/clients/${client.id}`, { headers: TS_B })).status()).toBe(404);

  // held ask call on /mcp, then revoke (same-origin DELETE)
  expect((await postMcp(request, null, token, LIST)).status()).toBe(200);
  const held = callTool(request, null, token, `${up.slug}_add_item`, { item: 'nach Widerruf' });
  const p = await waitPending(request, up.id, 'add_item', TS_REV);
  expect(p.clientName).toBe(name);
  const t0 = Date.now();
  expect((await request.delete(`/api/mcp/clients/${client.id}`, { headers: { ...TS_REV, 'Sec-Fetch-Site': 'same-origin' } })).status()).toBe(204);
  const result = await held;
  expect(Date.now() - t0).toBeLessThan(2500);
  expect(result.isError).toBe(true);
  const audit = dbAll('select * from AuditEntry where approvalId = ?', p.id)[0];
  expect(audit.outcome).toBe('DENIED');
  expect(audit.decisionPath).toMatch(/\+revoked$/);
  expect((await decide(request, p.id, { decision: 'approve' }, TS_REV)).status()).toBe(409);
  for (const slug of [null, up.slug]) expect((await postMcp(request, slug, token, LIST)).status(), String(slug)).toBe(401);
  expect(await callsOf(request, up.tenant)).toEqual({});
});
