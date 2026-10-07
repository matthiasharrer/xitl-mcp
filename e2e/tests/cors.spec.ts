// Browser origins per access token (ADR-0023): TC-96…99.
//
// Origins are listed by ANY token of any user (the preflight can't know the
// token), and the e2e DB is shared across specs: every case uses its own
// unique origins, so "unlisted" really is unlisted.
import crypto from 'node:crypto';
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { CO_A, CO_B, CO_UI, dbAll, uniq } from '../support/db.js';
import { INITIALIZE, LIST, parseRpc, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { connectedUpstream, fakeState } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

type User = Record<string, string>;
interface Client {
  id: number;
  name: string;
  kind: 'OAUTH' | 'TOKEN';
  allowedOrigins: string[];
}

const uniqOrigin = (prefix: string) => `https://${prefix}-${crypto.randomBytes(4).toString('hex')}.example`;
const corsHeaders = (res: APIResponse) => Object.keys(res.headers()).filter((h) => h.toLowerCase().startsWith('access-control-'));

async function createToken(request: APIRequestContext, user: User, scope: { upstreamId: number } | 'all', data: Record<string, unknown>) {
  const url = scope === 'all' ? '/api/mcp/tokens' : `/api/upstreams/${scope.upstreamId}/tokens`;
  return request.post(url, { headers: user, data: { name: uniq('Token'), ...data } });
}
async function token(request: APIRequestContext, user: User, scope: { upstreamId: number } | 'all', allowedOrigins?: string[]) {
  const res = await createToken(request, user, scope, allowedOrigins ? { allowedOrigins } : {});
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { client: Client; token: string };
}
async function clients(request: APIRequestContext, user: User): Promise<Client[]> {
  return (await request.get('/api/mcp/clients', { headers: user })).json();
}
const patchClient = (request: APIRequestContext, user: User, id: number, data: unknown) =>
  request.patch(`/api/mcp/clients/${id}`, { headers: user, data });

/** A connected upstream with list_items ALLOWed (tools known). */
async function upstream(request: APIRequestContext, prefix: string, user: User) {
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Up ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const view = (await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: user })).json()) as { tools: { id: number; name: string }[] };
  const tool = view.tools.find((t) => t.name === 'list_items')!;
  expect((await request.patch(`/api/upstreams/${up.id}/tools/${tool.id}`, { headers: user, data: { policy: 'ALLOW' } })).status()).toBe(200);
  return up;
}

test('TC-96 Origins an Tokens (API): normalisiert gespeichert, gelistet, PATCH ersetzt, 400 bei Ungültigem, OAuth -> origins_token_only, fremd -> 404', async ({ request }) => {
  const up = await upstream(request, 'tc96', CO_A);
  const one = await token(request, CO_A, { upstreamId: up.id }, ['HTTPS://UI.Example:443/', 'http://localhost:8080', 'https://ui.example']);
  expect(one.client.allowedOrigins).toEqual(['https://ui.example', 'http://localhost:8080']);
  const all = await token(request, CO_A, 'all', ['http://[::1]:5173/']);
  expect(all.client.allowedOrigins).toEqual(['http://[::1]:5173']);
  const none = await token(request, CO_A, 'all');
  expect(none.client.allowedOrigins).toEqual([]);
  expect(dbAll('select allowedOrigins from McpClient where id = ?', one.client.id)[0].allowedOrigins).toBe('["https://ui.example","http://localhost:8080"]');

  const listed = await clients(request, CO_A);
  expect(listed.find((c) => c.id === one.client.id)!.allowedOrigins).toEqual(['https://ui.example', 'http://localhost:8080']);
  expect(listed.find((c) => c.id === all.client.id)!.allowedOrigins).toEqual(['http://[::1]:5173']);

  // PATCH replaces (also with []); duplicates collapse; the name is kept
  let res = await patchClient(request, CO_A, one.client.id, { allowedOrigins: ['http://localhost:3000', 'HTTP://LOCALHOST:3000/'] });
  expect(res.status()).toBe(200);
  expect((await res.json()).allowedOrigins).toEqual(['http://localhost:3000']);
  expect((await res.json()).name).toBe(one.client.name);
  res = await patchClient(request, CO_A, one.client.id, { allowedOrigins: [] });
  expect(res.status()).toBe(200);
  expect((await res.json()).allowedOrigins).toEqual([]);
  // renaming alone still works and leaves the origins alone
  await patchClient(request, CO_A, all.client.id, { name: 'Umbenannt' });
  expect((await clients(request, CO_A)).find((c) => c.id === all.client.id)).toMatchObject({ name: 'Umbenannt', allowedOrigins: ['http://[::1]:5173'] });

  // invalid entries: 400 in German, on create (nothing created) and on PATCH (nothing changed)
  const bad = ['https://a.example/x', 'https://a.example?q=1', 'https://a.example#f', 'https://user@a.example', '*', 'null', 'ftp://a.example', 'kein url', 42];
  const before = (await clients(request, CO_A)).length;
  for (const entry of bad) {
    const created = await createToken(request, CO_A, 'all', { allowedOrigins: ['https://ok.example', entry] });
    expect(created.status(), String(entry)).toBe(400);
    const body = await created.json();
    expect(body.error).toMatch(/keine gültige Web-Adresse/);
    const patched = await patchClient(request, CO_A, all.client.id, { allowedOrigins: [entry] });
    expect(patched.status(), String(entry)).toBe(400);
    expect((await patched.json()).error).toMatch(/keine gültige Web-Adresse/);
  }
  const eleven = Array.from({ length: 11 }, (_, i) => `https://h${i}.example`);
  const tooMany = await createToken(request, CO_A, { upstreamId: up.id }, { allowedOrigins: eleven });
  expect(tooMany.status()).toBe(400);
  expect((await tooMany.json()).error).toBe('Höchstens 10 Web-Adressen pro Token.');
  expect((await patchClient(request, CO_A, all.client.id, { allowedOrigins: eleven })).status()).toBe(400);
  expect((await patchClient(request, CO_A, all.client.id, { allowedOrigins: 'https://a.example' })).status()).toBe(400);
  expect((await clients(request, CO_A)).length).toBe(before);
  expect((await clients(request, CO_A)).find((c) => c.id === all.client.id)!.allowedOrigins).toEqual(['http://[::1]:5173']);

  // OAuth client: 400 origins_token_only; listed with []
  await runOAuthFlow(request, uniq('OAuth tc96'), CO_A);
  const oauth = (await clients(request, CO_A)).find((c) => c.kind === 'OAUTH')!;
  expect(oauth.allowedOrigins).toEqual([]);
  const refused = await patchClient(request, CO_A, oauth.id, { allowedOrigins: ['https://ui.example'] });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe('origins_token_only');
  expect(dbAll('select allowedOrigins from McpClient where id = ?', oauth.id)[0].allowedOrigins).toBe('[]');

  // another user's client: 404, unchanged
  expect((await patchClient(request, CO_B, all.client.id, { allowedOrigins: ['https://evil.example'] })).status()).toBe(404);
  expect((await clients(request, CO_A)).find((c) => c.id === all.client.id)!.allowedOrigins).toEqual(['http://[::1]:5173']);
});

test('TC-97 Preflight: gelistete Origin -> 204 mit genau den CORS-Headern; fremde -> 403 ohne; andere Routen nie CORS', async ({ request }) => {
  const up = await upstream(request, 'tc97', CO_A);
  const listed = uniqOrigin('tc97');
  await token(request, CO_A, { upstreamId: up.id }, [listed]);
  const preflight = (path: string, origin: string) =>
    request.fetch(path, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, mcp-session-id' },
    });

  for (const path of ['/mcp', `/mcp/${up.slug}`, '/mcp/irgendein-slug']) {
    const res = await preflight(path, listed);
    expect(res.status(), path).toBe(204);
    const h = res.headers();
    expect(h['access-control-allow-origin']).toBe(listed);
    expect(h['vary']).toMatch(/\bOrigin\b/);
    expect(h['access-control-allow-methods']).toBe('GET, POST, DELETE');
    expect(h['access-control-allow-headers']).toBe('Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    expect(h['access-control-max-age']).toBe('600');
    expect(h['access-control-allow-credentials']).toBeUndefined();
    expect(corsHeaders(res).sort()).toEqual(
      ['access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin', 'access-control-max-age'],
    );
  }
  // unlisted (and near misses): 403, no Access-Control-*
  for (const origin of [uniqOrigin('tc97-other'), listed.replace('https:', 'http:'), `${listed}:8443`, `${listed}.evil`, 'null']) {
    const res = await preflight('/mcp', origin);
    expect(res.status(), origin).toBe(403);
    expect(corsHeaders(res), origin).toEqual([]);
  }
  // no other route ever answers with CORS, even for a listed origin
  for (const path of ['/api/upstreams', '/api/mcp/clients', '/oauth/authorize', '/mcp/token', '/mcp/register', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/', '/sw.js']) {
    // OPTIONS on static paths too (TC-101: a 204 without a body, never a hang)
    for (const method of ['OPTIONS', 'GET', 'POST']) {
      const res = await request.fetch(path, { method, headers: { Origin: listed, ...CO_A }, maxRedirects: 0, timeout: 2000 });
      expect(corsHeaders(res), `${method} ${path}`).toEqual([]);
    }
  }
});

test('TC-98 Requests mit Origin: gelistet -> normal + CORS; anderes Token -> 403 ohne Wirkung; 401 lesbar; OAuth unverändert', async ({ request }) => {
  const up = await upstream(request, 'tc98', CO_A);
  const listed = uniqOrigin('tc98');
  const allowed = await token(request, CO_A, 'all', [listed]);
  const other = await token(request, CO_A, 'all', [uniqOrigin('tc98-other')]);
  const withOrigin = (origin: string, extra: Record<string, string> = {}) => ({ headers: { Origin: origin, ...extra } });

  // the listed token: initialize, tools/list, tools/call as without Origin, plus CORS headers
  const expectCors = (res: APIResponse) => {
    const h = res.headers();
    expect(h['access-control-allow-origin']).toBe(listed);
    expect(h['vary']).toMatch(/\bOrigin\b/);
    expect(h['access-control-expose-headers']).toContain('Mcp-Session-Id');
    expect(h['access-control-expose-headers']).toContain('WWW-Authenticate');
    expect(h['access-control-allow-credentials']).toBeUndefined();
  };
  const init = await postMcp(request, null, allowed.token, INITIALIZE, withOrigin(listed));
  expect(init.status()).toBe(200);
  expectCors(init);
  expect(init.headers()['mcp-session-id']).toBeTruthy();
  expect((await parseRpc(init)).result.serverInfo.name).toBe('xitl');
  const list = await postMcp(request, `${up.slug}`, allowed.token, LIST, withOrigin(listed));
  expect(list.status()).toBe(200);
  expectCors(list);
  expect(((await parseRpc(list)).result.tools as { name: string }[]).map((t) => t.name)).toContain('list_items');
  const callsBefore = (await fakeState(request, up.tenant)).calls['list_items'] ?? 0;
  const call = await postMcp(request, null, allowed.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: `${up.slug}_list_items`, arguments: {} } }, withOrigin(listed));
  expect(call.status()).toBe(200);
  expectCors(call);
  expect((await parseRpc(call)).result.isError).toBeFalsy();
  expect((await fakeState(request, up.tenant)).calls['list_items']).toBe(callsBefore + 1);
  // the same token without Origin: unchanged, no CORS
  const plain = await postMcp(request, null, allowed.token, LIST);
  expect(plain.status()).toBe(200);
  expect(corsHeaders(plain)).toEqual([]);

  // a token that doesn't list the origin (another token does): 403 before anything happens
  const uid = dbAll('select id from User where username = ?', CO_A['Remote-User'])[0].id as number;
  const audits = () => dbAll('select count(*) c from AuditEntry where userId = ?', uid)[0].c as number;
  const auditBefore = audits();
  const reqsBefore = (await fakeState(request, up.tenant)).mcpRequests;
  for (const body of [INITIALIZE, LIST, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: `${up.slug}_list_items`, arguments: {} } }]) {
    for (const slug of [null, up.slug]) {
      const res = await postMcp(request, slug, other.token, body, withOrigin(listed));
      expect(res.status()).toBe(403);
      expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
      expect(corsHeaders(res)).toEqual([]);
    }
  }
  for (const method of ['GET', 'DELETE']) {
    const res = await request.fetch('/mcp', { method, headers: { Origin: listed, Authorization: `Bearer ${other.token}`, Accept: 'text/event-stream' } });
    expect(res.status(), method).toBe(403);
  }
  // also the allowed token from an unlisted / null origin
  expect((await postMcp(request, null, allowed.token, LIST, withOrigin(uniqOrigin('tc98-x')))).status()).toBe(403);
  expect((await postMcp(request, null, allowed.token, LIST, withOrigin('null'))).status()).toBe(403);
  expect(audits()).toBe(auditBefore);
  expect((await fakeState(request, up.tenant)).mcpRequests).toBe(reqsBefore);
  expect(dbAll('select lastUsedAt from McpClient where id = ?', other.client.id)[0].lastUsedAt).toBeNull();

  // no token / a bad token with a listed origin: a 401 challenge the page can read
  for (const bearer of [null, 'xitl_' + 'A'.repeat(43), 'not-a-token']) {
    const res = await postMcp(request, null, bearer, LIST, withOrigin(listed));
    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toContain('Bearer');
    expect(res.headers()['access-control-allow-origin']).toBe(listed);
    expect(res.headers()['access-control-expose-headers']).toContain('WWW-Authenticate');
  }
  // ... but not for an origin nobody lists
  const unlisted401 = await postMcp(request, null, null, LIST, withOrigin(uniqOrigin('tc98-nobody')));
  expect(unlisted401.status()).toBe(401);
  expect(corsHeaders(unlisted401)).toEqual([]);

  // an OAuth client with an Origin: served as today, no CORS headers
  const oauth = await runOAuthFlow(request, uniq('OAuth tc98'), CO_A);
  for (const origin of [listed, uniqOrigin('tc98-oauth')]) {
    const res = await postMcp(request, null, oauth.accessToken, LIST, withOrigin(origin));
    expect(res.status()).toBe(200);
    expect(corsHeaders(res)).toEqual([]);
    expect(((await parseRpc(res)).result.tools as { name: string }[]).map((t) => t.name)).toContain(`${up.slug}_list_items`);
  }
});

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: CO_UI });

  test('TC-99 UI @390x844: Feld "Erlaubte Web-Adressen" beim Token, Fehler am Feld, Liste zeigt sie, "Web-Adressen bearbeiten" nur bei Tokens', async ({ page, request }) => {
    const up = await connectedUpstream(request, 'tc99', { name: uniq('Up tc99') }, CO_UI);
    await runOAuthFlow(request, uniq('OAuth tc99'), CO_UI);
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/regeln/${up.id}`);
    await page.getByRole('button', { name: `Token für ${up.name} erstellen` }).click();
    const sheet = page.locator('dialog.sheet');
    const field = sheet.getByLabel('Erlaubte Web-Adressen (Browser-Clients)');
    await expect(field).toBeVisible();
    await expect(sheet).toContainText('llama.cpp');
    const name = uniq('llama UI');
    await sheet.getByLabel('Name des Clients').fill(name);
    await field.fill('https://a.example/pfad');
    await sheet.getByRole('button', { name: 'Erstellen' }).click();
    await expect(sheet.locator('.field-error')).toContainText('keine gültige Web-Adresse');
    expect(await noScroll()).toBe(true);
    await field.fill('HTTP://LOCALHOST:8080/\n\n');
    await sheet.getByRole('button', { name: 'Erstellen' }).click();
    await expect(sheet.getByText('Wird nur jetzt angezeigt.')).toBeVisible();
    await sheet.getByRole('button', { name: 'Fertig' }).click();
    await page.goto('/#/einstellungen');

    const list = page.getByRole('list', { name: 'MCP-Clients' });
    await list.locator('li.item', { hasText: name }).getByRole('link', { name: `${name} öffnen` }).click();
    const row = page.getByTestId('client-general');
    await expect(row.getByTestId('token-origins')).toHaveText('Im Browser erlaubt: http://localhost:8080');
    await row.getByRole('button', { name: 'Web-Adressen bearbeiten' }).click();
    const edit = page.locator('dialog.sheet');
    await expect(edit.getByRole('heading', { name: 'Web-Adressen' })).toBeVisible();
    const editField = edit.getByLabel('Erlaubte Web-Adressen (Browser-Clients)');
    await expect(editField).toHaveValue('http://localhost:8080');
    await editField.fill('ftp://x.example');
    await edit.getByRole('button', { name: 'Speichern' }).click();
    await expect(edit.locator('.field-error')).toContainText('keine gültige Web-Adresse');
    await editField.fill('http://localhost:8080\nhttps://UI.example');
    await edit.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.locator('dialog.sheet')).toHaveCount(0);
    await expect(row.getByTestId('token-origins')).toHaveText('Im Browser erlaubt: http://localhost:8080, https://ui.example');
    expect(await noScroll()).toBe(true);

    // OAuth clients have no such action
    await page.goto('/#/einstellungen');
    await list.locator('li.item', { hasText: 'OAuth tc99' }).getByRole('link', { name: /^OAuth tc99.* öffnen$/ }).click();
    await expect(page.getByTestId('client-general')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Web-Adressen bearbeiten' })).toHaveCount(0);
    await page.goto('/#/einstellungen');

    // the "Alle Upstreams" token sheet has the field too
    await page.getByRole('button', { name: 'Token für alle Upstreams erstellen' }).click();
    await expect(page.locator('dialog.sheet').getByLabel('Erlaubte Web-Adressen (Browser-Clients)')).toBeVisible();
    expect(await noScroll()).toBe(true);
  });
});
