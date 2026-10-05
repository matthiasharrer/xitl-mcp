// Per-upstream access tokens (ADR-0015): TC-50…TC-54. A token is a client of
// kind TOKEN, valid only on /mcp/<its upstream's slug> for its own user, stored
// only as SHA-256. Every refusal must be a 401 with nothing reaching the upstream.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ANNA, MATTHIAS, createUpstream, dbAll, dbRun, uniq, uniqSlug } from '../support/db.js';
import { AUTHORIZE, INITIALIZE, LIST, authorizeParams, csrfFrom, forgeBlob, pkcePair, postMcp, registerMcpClient, runOAuthFlow } from '../support/mcpClient.js';
import { API_LOG, MCP_TOKEN } from '../support/paths.js';
import { callTool, fakeState, listTools } from '../support/upstream.js';
import { askUpstream, decide, lastAudit, startCall, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

interface Created {
  client: { id: number; name: string; kind: string; tokenPrefix: string; upstream: { id: number; slug: string; name: string } };
  token: string;
}
async function createToken(request: APIRequestContext, upstreamId: number, name: string, user = MATTHIAS): Promise<Created> {
  const res = await request.post(`/api/upstreams/${upstreamId}/tokens`, { headers: user, data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const tamper = (t: string) => t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: MATTHIAS });

  test('TC-50 Token erstellen: Name -> Token einmalig mit Kopieren und Konfig-Beispiel; Liste zeigt Name, Upstream, Präfix, zuletzt benutzt, nie das Token', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:3202' }).catch(() => undefined);
    const { up } = await askUpstream(request, 'tc50', { name: uniq('Haushalt TC50') });
    const name = uniq('Claude Code Laptop');

    await page.goto('/#/einstellungen');
    const card = page.locator(`li.item[data-slug="${up.slug}"]`);
    await card.getByRole('button', { name: `Token für ${up.name} erstellen` }).click();
    const sheet = page.locator('dialog.sheet');
    await expect(sheet.getByRole('heading', { name: 'Token erstellen' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Erstellen' })).toBeDisabled(); // a name is required
    await sheet.getByLabel('Name des Clients').fill(name);
    await sheet.getByRole('button', { name: 'Erstellen' }).click();

    await expect(sheet.getByText('Wird nur jetzt angezeigt.')).toBeVisible();
    const token = (await sheet.getByTestId('token-value').innerText()).trim();
    expect(token).toMatch(/^xitl_[A-Za-z0-9_-]{43}$/);
    const command = (await sheet.getByTestId('token-command').innerText()).trim();
    expect(command).toBe(`claude mcp add --transport http ${up.slug} http://127.0.0.1:3202/mcp/${up.slug} --header "Authorization: Bearer ${token}"`);
    await expect(sheet).toContainText(`Header: Authorization: Bearer ${token}`);
    for (const label of ['Token kopieren', 'Befehl kopieren', 'Fertig']) {
      expect((await sheet.getByRole('button', { name: label }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await sheet.getByRole('button', { name: 'Token kopieren' }).click();
    await expect(sheet.getByRole('button', { name: 'Kopiert' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Fertig' }).click();
    await expect(sheet).toHaveCount(0);

    // the list: name, upstream, prefix, "noch nie benutzt" - never the token
    const clients = page.getByRole('list', { name: 'MCP-Clients' });
    const row = clients.locator('li.item', { hasText: name });
    await expect(row).toContainText(`Token für ${up.name}`);
    await expect(row.getByTestId('token-prefix')).toHaveText(`${token.slice(0, 12)}…`);
    await expect(row).toContainText('noch nie benutzt');
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(await page.content()).not.toContain(token);

    // used once -> "zuletzt benutzt"
    expect((await postMcp(request, up.slug, token, LIST)).status()).toBe(200);
    await page.reload();
    await expect(clients.locator('li.item', { hasText: name })).toContainText('zuletzt benutzt');
    expect(await page.content()).not.toContain(token);

    // reopening the list never offers the token again, revoke asks first
    await clients.locator('li.item', { hasText: name }).getByRole('button', { name: 'Trennen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Trennen' }).click();
    await expect(clients.locator('li.item', { hasText: name })).toHaveCount(0);
    expect((await postMcp(request, up.slug, token, LIST)).status()).toBe(401);
  });

  test('TC-50 Regeln: Pro-Client-Überschreibung listet Token-Clients dieses Upstreams und OAuth-Clients, nicht Token anderer Upstreams', async ({ page, request }) => {
    const { up } = await askUpstream(request, 'tc50r');
    const other = await createUpstream(request, MATTHIAS, {});
    const mine = await createToken(request, up.id, uniq('Token A'));
    const foreign = await createToken(request, other.id, uniq('Token B'));
    const view = await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: MATTHIAS })).json();
    const names = view.clients.map((c: any) => c.name);
    expect(names).toContain(mine.client.name);
    expect(names).not.toContain(foreign.client.name);
    expect(names.length).toBeGreaterThan(1); // the askUpstream OAuth client is still there
    // a token client of another upstream cannot get a rule here (404, like an unknown client)
    const toolId = view.tools[0].id;
    expect((await request.put(`/api/upstreams/${up.id}/tools/${toolId}/clients/${foreign.client.id}`, { headers: MATTHIAS, data: { policy: 'ALLOW' } })).status()).toBe(404);
    expect((await request.put(`/api/upstreams/${up.id}/tools/${toolId}/clients/${mine.client.id}`, { headers: MATTHIAS, data: { policy: 'DENY' } })).status()).toBe(200);

    await page.goto(`/#/regeln/${up.id}`);
    await page.locator('details.client-overrides').first().locator('summary').click();
    await expect(page.locator('.client-name', { hasText: mine.client.name }).first()).toBeVisible();
    await expect(page.locator('.client-name', { hasText: foreign.client.name })).toHaveCount(0);
  });
});

test('TC-51 Token wie OAuth-Client: initialize/tools/list/tools/call, Policy, Client-Override, ask -> Freigabe mit Token-Name, Audit, lastUsedAt', async ({ request }) => {
  const { up } = await askUpstream(request, 'tc51');
  const name = uniq('Token TC51');
  const { client, token } = await createToken(request, up.id, name);
  expect(client).toMatchObject({ name, kind: 'TOKEN', upstream: { id: up.id, slug: up.slug } });
  expect(dbAll('select lastUsedAt from McpClient where id = ?', client.id)[0].lastUsedAt).toBeNull();

  const init = await postMcp(request, up.slug, token, INITIALIZE);
  expect(init.status()).toBe(200);
  expect(await init.text()).toContain('xitl');
  const tools = await listTools(request, up.slug, token);
  expect(tools.map((t) => t.name)).toContain('add_item');
  await expect.poll(() => dbAll('select lastUsedAt from McpClient where id = ?', client.id)[0].lastUsedAt).not.toBeNull();
  const firstUse = dbAll('select lastUsedAt from McpClient where id = ?', client.id)[0].lastUsedAt;
  await listTools(request, up.slug, token); // within a minute: not bumped again
  expect(dbAll('select lastUsedAt from McpClient where id = ?', client.id)[0].lastUsedAt).toBe(firstUse);

  // ask -> held, shown with the token's name, then approved
  const held = startCall(request, up.slug, token, 'add_item', { item: 'Token-Eier' });
  const p = await waitPending(request, up.id, 'add_item');
  expect(p.clientName).toBe(name);
  expect((await decide(request, p.id, { decision: 'approve' })).status()).toBe(200);
  expect(await held).toEqual({ content: [{ type: 'text', text: 'hinzugefügt: Token-Eier' }] });
  expect(lastAudit(up.id)).toMatchObject({ mcpClientId: client.id, outcome: 'FORWARDED', decisionPath: 'policy:upstream-default+approved:page' });

  // a per-client override for the token client: ALLOW needs no approval, DENY is refused
  const view = await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: MATTHIAS })).json();
  const toolId = view.tools.find((t: any) => t.name === 'add_item').id;
  expect(view.clients.map((c: any) => c.id)).toContain(client.id);
  expect((await request.put(`/api/upstreams/${up.id}/tools/${toolId}/clients/${client.id}`, { headers: MATTHIAS, data: { policy: 'ALLOW' } })).status()).toBe(200);
  expect(await callTool(request, up.slug, token, 'add_item', { item: 'frei' })).toEqual({ content: [{ type: 'text', text: 'hinzugefügt: frei' }] });
  expect(lastAudit(up.id)).toMatchObject({ mcpClientId: client.id, decisionPath: 'policy:client' });
  expect((await request.put(`/api/upstreams/${up.id}/tools/${toolId}/clients/${client.id}`, { headers: MATTHIAS, data: { policy: 'DENY' } })).status()).toBe(200);
  const denied = await callTool(request, up.slug, token, 'add_item', { item: 'nein' });
  expect(denied.isError).toBe(true);
  expect((await fakeState(request, up.tenant)).calls.add_item).toBe(2);
});

test('TC-52 Token nur im genauen Scope: anderer Upstream, anderer User, verändert, MCP_TOKEN, OAuth-Token, TOKEN-Client nie als OAuth -> 401', async ({ request }) => {
  const { up } = await askUpstream(request, 'tc52');
  const sibling = await createUpstream(request, MATTHIAS, {});
  const { token, client } = await createToken(request, up.id, uniq('Token TC52'));
  expect((await postMcp(request, up.slug, token, LIST)).status()).toBe(200);

  // same user, other upstream
  expect((await postMcp(request, sibling.slug, token, LIST)).status()).toBe(401);
  // a slug that does not exist: the same 401 (no oracle)
  const missing = await postMcp(request, uniqSlug('nope'), token, LIST);
  expect(missing.status()).toBe(401);
  const wrong = await postMcp(request, sibling.slug, token, LIST);
  expect(missing.headers()['www-authenticate']).toBeTruthy();
  expect(wrong.headers()['www-authenticate']).toContain('resource_metadata=');
  expect(await missing.text()).toBe(await wrong.text());
  // another user's upstream with the same slug name
  const annaUp = await createUpstream(request, ANNA, { slug: uniqSlug('anna') });
  expect((await postMcp(request, annaUp.slug, token, LIST)).status()).toBe(401);
  // slugs are per user: Anna owning the SAME slug changes nothing (the token's owner decides, never the URL)
  await createUpstream(request, ANNA, { slug: up.slug });
  expect((await postMcp(request, up.slug, token, LIST)).status()).toBe(200);
  expect((await fakeState(request, up.tenant)).calls.add_item ?? 0).toBe(0);
  // tampered, truncated, wrong case, empty, prefix only
  for (const bad of [tamper(token), token.slice(0, -1), token.toUpperCase(), 'xitl_', 'xitl_' + 'A'.repeat(43)]) {
    expect((await postMcp(request, up.slug, bad, LIST)).status(), bad).toBe(401);
  }
  // the stored hash is not a bearer; a token-shaped string is never run through OAuth
  const hash = dbAll('select tokenHash from McpClient where id = ?', client.id)[0].tokenHash;
  expect((await postMcp(request, up.slug, hash, LIST)).status()).toBe(401);
  expect((await postMcp(request, up.slug, `xitl_${hash}`, LIST)).status()).toBe(401);
  // MCP_TOKEN still rejected, OAuth tokens still work
  expect((await postMcp(request, up.slug, MCP_TOKEN, LIST)).status()).toBe(401);
  const oauth = await runOAuthFlow(request, uniq('tc52 oauth'), MATTHIAS);
  expect((await postMcp(request, up.slug, oauth.accessToken, LIST)).status()).toBe(200);
  // the call count at the upstream is untouched by all the refusals
  expect((await fakeState(request, up.tenant)).calls.add_item ?? 0).toBe(0);
  // an unknown / row without user or upstream or of kind OAUTH never passes (fail closed)
  for (const [col, val] of [['kind', 'OAUTH'], ['userId', null], ['upstreamId', null]] as const) {
    const before = dbAll(`select ${col} v from McpClient where id = ?`, client.id)[0].v;
    dbRun(`update McpClient set ${col} = ? where id = ?`, val, client.id);
    expect((await postMcp(request, up.slug, token, LIST)).status(), col).toBe(401);
    dbRun(`update McpClient set ${col} = ? where id = ?`, before, client.id);
  }
  expect((await postMcp(request, up.slug, token, LIST)).status()).toBe(200);

  // a TOKEN client id can never obtain OAuth artefacts
  const clientId = dbAll('select clientId from McpClient where id = ?', client.id)[0].clientId as string;
  const { verifier, challenge } = pkcePair();
  const params = authorizeParams(clientId, challenge);
  expect((await request.get(AUTHORIZE, { params, headers: MATTHIAS, maxRedirects: 0 })).status()).toBe(400);
  // even with a CSRF value from a legitimate consent page and a forced redirect_uri
  const real = await registerMcpClient(request, uniq('tc52 real'));
  const consent = await request.get(AUTHORIZE, { params: authorizeParams(real, challenge), headers: MATTHIAS, maxRedirects: 0 });
  const csrf = await csrfFrom(consent);
  const post = await request.post(AUTHORIZE, { form: { ...params, csrf, decision: 'allow' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(post.status()).toBe(400);
  expect(post.headers()['location']).toBeUndefined();
  for (const form of [
    { grant_type: 'authorization_code', code: 'x', code_verifier: verifier, client_id: clientId, redirect_uri: 'https://example.com/callback' },
    { grant_type: 'refresh_token', refresh_token: 'x', client_id: clientId },
  ]) {
    expect((await request.post('/mcp/token', { form })).status()).toBe(400);
  }
  // forged-but-correctly-signed OAuth blobs naming the TOKEN client's clientId are refused at the gate and the token endpoint
  const uid = dbAll('select userId from McpClient where id = ?', client.id)[0].userId;
  const now = Math.floor(Date.now() / 1000);
  const forgedAccess = forgeBlob({ typ: 'access', cid: clientId, uid, scope: ['mcp'], iat: now, exp: now + 600 }, MCP_TOKEN);
  expect((await postMcp(request, up.slug, forgedAccess, LIST)).status()).toBe(401);
  const forgedRefresh = forgeBlob({ typ: 'refresh', cid: clientId, uid, scope: ['mcp'], iat: now, exp: now + 600 }, MCP_TOKEN);
  expect((await request.post('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: forgedRefresh, client_id: clientId } })).status()).toBe(400);
  // DCR cannot create TOKEN rows, whatever it is told
  const dcr = await request.post('/mcp/register', { data: { redirect_uris: ['https://example.com/callback'], client_name: uniq('tc52 dcr'), kind: 'TOKEN', upstreamId: up.id, tokenHash: sha('x') } });
  expect(dcr.status()).toBe(201);
  const dcrId = (await dcr.json()).client_id;
  expect(dbAll('select kind, upstreamId, tokenHash from McpClient where clientId = ?', dcrId)[0]).toEqual({ kind: 'OAUTH', upstreamId: null, tokenHash: null });
});

test('TC-53 Widerruf: nächster Aufruf 401, wartender Aufruf sofort abgelehnt (+revoked); Upstream löschen löscht Token-Clients', async ({ request }) => {
  const { up } = await askUpstream(request, 'tc53');
  const { token, client } = await createToken(request, up.id, uniq('Token TC53'));
  expect((await postMcp(request, up.slug, token, LIST)).status()).toBe(200);

  const held = startCall(request, up.slug, token, 'add_item', { item: 'nach Widerruf' });
  const p = await waitPending(request, up.id, 'add_item');
  const t0 = Date.now();
  expect((await request.delete(`/api/mcp/clients/${client.id}`, { headers: MATTHIAS })).status()).toBe(204);
  const result = await held;
  expect(Date.now() - t0).toBeLessThan(2500);
  expect(result.isError).toBe(true);
  expect(dbAll('select * from AuditEntry where approvalId = ?', p.id)[0]).toMatchObject({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+revoked' });
  expect((await decide(request, p.id, { decision: 'approve' })).status()).toBe(409);
  expect((await postMcp(request, up.slug, token, LIST)).status()).toBe(401);
  expect((await fakeState(request, up.tenant)).calls.add_item ?? 0).toBe(0);
  // someone else cannot revoke it (404), and it is gone from the list
  const second = await createToken(request, up.id, uniq('Token TC53b'));
  expect((await request.delete(`/api/mcp/clients/${second.client.id}`, { headers: ANNA })).status()).toBe(404);
  expect((await postMcp(request, up.slug, second.token, LIST)).status()).toBe(200);

  // deleting the upstream deletes its token clients (and the token stops working)
  expect((await request.delete(`/api/upstreams/${up.id}`, { headers: MATTHIAS })).status()).toBe(204);
  expect(dbAll('select count(*) n from McpClient where upstreamId = ?', up.id)[0].n).toBe(0);
  expect((await postMcp(request, up.slug, second.token, LIST)).status()).toBe(401);
});

test('TC-54 Nur der SHA-256 liegt vor; Token nirgends nach der Antwort; Sec-Fetch-Guard, Name 1-100, fremder Upstream 404', async ({ request }) => {
  const { up } = await askUpstream(request, 'tc54');
  const name = uniq('Token TC54');
  const { token, client } = await createToken(request, up.id, name);
  expect(token).toMatch(/^xitl_[A-Za-z0-9_-]{43}$/);

  const row = dbAll('select * from McpClient where id = ?', client.id)[0];
  expect(row).toMatchObject({ kind: 'TOKEN', tokenHash: sha(token), tokenPrefix: token.slice(0, 12), upstreamId: up.id, redirectUris: '[]' });
  // no value of any column of any table is the token
  const Database = (await import('node:module')).createRequire(import.meta.url)('better-sqlite3');
  const { DB_PATH } = await import('../support/paths.js');
  const db = new Database(DB_PATH, { readonly: true });
  try {
    for (const { name: table } of db.prepare("select name from sqlite_master where type = 'table'").all()) {
      expect(JSON.stringify(db.prepare(`select * from "${table}"`).all()), table).not.toContain(token);
    }
  } finally {
    db.close();
  }

  // API responses after creation
  const secretsOk = async (res: { text(): Promise<string> }) => {
    const t = await res.text();
    expect(t).not.toContain(token);
    expect(t).not.toContain(sha(token));
    expect(t).not.toContain(row.clientId);
    return t;
  };
  const list = await request.get('/api/mcp/clients', { headers: MATTHIAS });
  const listed = JSON.parse(await secretsOk(list)).find((c: any) => c.id === client.id);
  expect(listed).toEqual({ id: client.id, name, kind: 'TOKEN', upstream: { id: up.id, slug: up.slug, name: up.name }, allUpstreams: false, tokenPrefix: token.slice(0, 12), createdAt: expect.any(String), lastUsedAt: null });
  await secretsOk(await request.get(`/api/upstreams`, { headers: MATTHIAS }));
  await secretsOk(await request.get(`/api/upstreams/${up.id}/tools`, { headers: MATTHIAS }));
  await secretsOk(await request.patch(`/api/mcp/clients/${client.id}`, { headers: MATTHIAS, data: { name: name + ' b' } }));
  await secretsOk(await request.get('/api/audit', { headers: MATTHIAS }));
  // used for a call: audit + log never contain it
  const held = startCall(request, up.slug, token, 'add_item', { item: 'x' });
  const p = await waitPending(request, up.id, 'add_item');
  await decide(request, p.id, { decision: 'deny' });
  await held;
  await secretsOk(await request.get('/api/audit', { headers: MATTHIAS }));
  await secretsOk(await request.get('/api/approvals', { headers: MATTHIAS }));
  const log = fs.readFileSync(API_LOG, 'utf8');
  expect(log).not.toContain(token);
  expect(log).not.toContain(sha(token));
  // a second creation yields a different token
  const again = await createToken(request, up.id, uniq('Token TC54b'));
  expect(again.token).not.toBe(token);

  // CSRF guard (TC-49 rule)
  for (const site of ['cross-site', 'same-site']) {
    const before = dbAll('select count(*) n from McpClient where upstreamId = ?', up.id)[0].n;
    const res = await request.post(`/api/upstreams/${up.id}/tokens`, { headers: { ...MATTHIAS, 'Sec-Fetch-Site': site }, data: { name: 'csrf' } });
    expect(res.status(), site).toBe(403);
    expect(dbAll('select count(*) n from McpClient where upstreamId = ?', up.id)[0].n).toBe(before);
  }
  expect((await request.post(`/api/upstreams/${up.id}/tokens`, { headers: { ...MATTHIAS, 'Sec-Fetch-Site': 'same-origin' }, data: { name: 'ok' } })).status()).toBe(201);

  // name: 1-100 chars after trim
  for (const bad of [undefined, '', '   ', 'x'.repeat(101), 5, null]) {
    expect((await request.post(`/api/upstreams/${up.id}/tokens`, { headers: MATTHIAS, data: { name: bad } })).status(), String(bad)).toBe(400);
  }
  expect((await request.post(`/api/upstreams/${up.id}/tokens`, { headers: MATTHIAS, data: { name: 'x'.repeat(100) } })).status()).toBe(201);
  // identity required; foreign / unknown upstream: 404, nothing created
  expect((await request.post(`/api/upstreams/${up.id}/tokens`, { data: { name: 'x' } })).status()).toBe(401);
  const before = dbAll('select count(*) n from McpClient')[0].n;
  expect((await request.post(`/api/upstreams/${up.id}/tokens`, { headers: ANNA, data: { name: 'x' } })).status()).toBe(404);
  expect((await request.post(`/api/upstreams/999999/tokens`, { headers: MATTHIAS, data: { name: 'x' } })).status()).toBe(404);
  expect(dbAll('select count(*) n from McpClient')[0].n).toBe(before);
  // Anna's list never shows Matthias's token client
  const annaList = await (await request.get('/api/mcp/clients', { headers: ANNA })).json();
  expect(annaList.map((c: any) => c.id)).not.toContain(client.id);
});
