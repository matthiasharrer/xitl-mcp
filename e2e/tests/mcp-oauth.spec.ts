// Inbound MCP OAuth and endpoint routing: TC-09…TC-14 (ADR-0012, ADR-0014).
// Raw HTTP via the `request` fixture; identity per request like Traefik would.
// Adapted from haushalts-todos' e2e/tests/mcp-oauth.spec.ts.
import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { ANNA, MATTHIAS, createUpstream, dbAll, uniq, uniqSlug } from '../support/db.js';
import { BASE_URL, DATABASE_URL, MCP_TOKEN, SERVER_ENTRY } from '../support/paths.js';
import {
  AUTHORIZE,
  INITIALIZE,
  LIST,
  authorizeParams,
  csrfFrom,
  exchangeCode,
  forgeBlob,
  parseRpc,
  pkcePair,
  postMcp,
  registerMcpClient,
  runOAuthFlow,
} from '../support/mcpClient.js';

test.use({ extraHTTPHeaders: {} });

/** First line of every proxied endpoint's instructions (apps/api/src/lib/proxyText.ts). */
const PREFIX = 'Über xitl vermittelt: manche Tools brauchen eine Freigabe. / Proxied by xitl: some tools need approval.';

const nowSec = () => Math.floor(Date.now() / 1000);

test('TC-09 DCR -> Consent als matthias (PKCE, CSRF) -> Token -> initialize + tools/list auf /mcp/<slug>', async ({
  request,
}) => {
  const slug = uniqSlug('tc09');
  await createUpstream(request, MATTHIAS, { slug, name: 'Haushalt TC09', description: 'Aufgaben im Haushalt' });

  // discovery
  const as = await (await request.get('/.well-known/oauth-authorization-server')).json();
  expect(as).toMatchObject({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/mcp/token`,
    registration_endpoint: `${BASE_URL}/mcp/register`,
    code_challenge_methods_supported: ['S256'],
  });

  const name = uniq('tc09 <b>x</b>');
  const clientId = await registerMcpClient(request, name);
  const { verifier, challenge } = pkcePair();
  const params = authorizeParams(clientId, challenge, 'st-1');

  const consent = await request.get(AUTHORIZE, { params, headers: MATTHIAS, maxRedirects: 0 });
  expect(consent.status()).toBe(200);
  const html = await consent.text();
  expect(html).toContain('Matthias');
  expect(html).toContain('&lt;b&gt;x&lt;/b&gt;'); // client name is escaped
  expect(html).not.toContain('<b>x</b>');
  const csrf = await csrfFrom(consent);
  expect(csrf).toBeTruthy();

  // CSRF mismatch -> refused, no redirect, no code, nothing bound
  const bad = await request.post(AUTHORIZE, { form: { ...params, csrf: 'wrong', decision: 'allow' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(bad.status()).toBe(400);
  expect(bad.headers()['location']).toBeUndefined();
  expect(dbAll('select userId from McpClient where clientId = ?', clientId)[0].userId).toBeNull();

  // deny -> redirect with access_denied, nothing bound
  const deny = await request.post(AUTHORIZE, { form: { ...params, csrf, decision: 'deny' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(deny.status()).toBe(302);
  const denyUrl = new URL(deny.headers()['location']!);
  expect(denyUrl.searchParams.get('error')).toBe('access_denied');
  expect(denyUrl.searchParams.get('state')).toBe('st-1');
  expect(denyUrl.searchParams.get('code')).toBeNull();
  expect(dbAll('select userId from McpClient where clientId = ?', clientId)[0].userId).toBeNull();

  // approve -> bound to matthias
  const ok = await request.post(AUTHORIZE, { form: { ...params, csrf, decision: 'allow' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(ok.status()).toBe(302);
  const code = new URL(ok.headers()['location']!).searchParams.get('code')!;
  expect(dbAll('select u.username from McpClient c join User u on u.id = c.userId where c.clientId = ?', clientId)[0].username).toBe('matthias');

  // PKCE mismatch -> invalid_grant
  const wrong = await exchangeCode(request, clientId, code, 'not-the-verifier');
  expect(wrong.status()).toBe(400);
  expect((await wrong.json()).error).toBe('invalid_grant');

  const tok = await exchangeCode(request, clientId, code, verifier);
  expect(tok.status()).toBe(200);
  const tokens = await tok.json();
  expect(tokens.token_type).toBe('Bearer');
  expect(tokens.refresh_token).toBeTruthy();

  // initialize + tools/list on the upstream's endpoint
  const init = await postMcp(request, slug, tokens.access_token, INITIALIZE);
  expect(init.status()).toBe(200);
  const initMsg = await parseRpc(init);
  expect(initMsg.result.serverInfo.name).toBe(`xitl/${slug}`);
  // not connected yet: the description stands in for the upstream's own
  // instructions, after xitl's one-line prefix (TC-19 covers a connected one)
  expect(initMsg.result.instructions).toBe(`${PREFIX}\n\nAufgaben im Haushalt`);
  const list = await postMcp(request, slug, tokens.access_token, LIST);
  expect(list.status()).toBe(200);
  const listMsg = await parseRpc(list);
  expect(listMsg.result.tools).toEqual([]); // not connected: nothing to list

  // a refresh keeps the binding
  const r = await request.post('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId } });
  expect(r.status()).toBe(200);
  expect((await postMcp(request, slug, (await r.json()).access_token, LIST)).status()).toBe(200);

  // the instructions fall back to the name when there is no description
  const plain = uniqSlug('tc09n');
  await createUpstream(request, MATTHIAS, { slug: plain, name: 'Nur Name' });
  const plainInit = await parseRpc(await postMcp(request, plain, tokens.access_token, INITIALIZE));
  expect(plainInit.result.instructions).toBe(`${PREFIX}\n\nNur Name`);

  // unregistered redirect_uri -> error page, never a redirect (GET and POST); unknown client likewise
  const evil = { ...params, redirect_uri: 'https://evil.example/cb' };
  const g = await request.get(AUTHORIZE, { params: evil, headers: MATTHIAS, maxRedirects: 0 });
  expect(g.status()).toBe(400);
  expect(g.headers()['location']).toBeUndefined();
  const p = await request.post(AUTHORIZE, { form: { ...evil, csrf, decision: 'allow' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(p.status()).toBe(400);
  expect(p.headers()['location']).toBeUndefined();
  const u = await request.get(AUTHORIZE, { params: { ...params, client_id: 'nope' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(u.status()).toBe(400);
  expect(u.headers()['location']).toBeUndefined();
  // plain PKCE refused (redirect with invalid_request)
  const plainPkce = await request.get(AUTHORIZE, { params: { ...params, code_challenge_method: 'plain' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(new URL(plainPkce.headers()['location']!).searchParams.get('error')).toBe('invalid_request');
});

test('TC-10 Ohne Token: 401 + WWW-Authenticate mit resource_metadata; Metadaten nennen resource = <origin>/mcp/<slug>', async ({
  request,
}) => {
  const slug = uniqSlug('tc10');
  await createUpstream(request, MATTHIAS, { slug });

  const res = await postMcp(request, slug, null, LIST);
  expect(res.status()).toBe(401);
  const challenge = res.headers()['www-authenticate'] ?? '';
  expect(challenge).toContain('Bearer');
  const metadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource/mcp/${slug}`;
  expect(challenge).toContain(`resource_metadata="${metadataUrl}"`);
  // refused before the SPA fallback would answer 200 with index.html
  const get = await request.get(`/mcp/${slug}`, { headers: { Accept: 'application/json, text/event-stream' } });
  expect(get.status()).toBe(401);
  // an unknown slug without a token is also just a 401: no slug oracle
  expect((await postMcp(request, uniqSlug('nope'), null, LIST)).status()).toBe(401);

  // the advertised URL answers with this resource
  const meta = await request.get(metadataUrl);
  expect(meta.status()).toBe(200);
  expect(await meta.json()).toMatchObject({
    resource: `${BASE_URL}/mcp/${slug}`,
    authorization_servers: [BASE_URL],
    scopes_supported: ['mcp'],
  });
  // the bare document (probed by some clients) is still there
  expect(await (await request.get('/.well-known/oauth-protected-resource')).json()).toMatchObject({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
  });
  // the slug is echoed into the document, so junk and OAuth words are refused
  for (const bad of ['register', 'token', 'Bad_Slug', '-x', 'a'.repeat(33)]) {
    expect((await request.get(`/.well-known/oauth-protected-resource/mcp/${bad}`)).status(), bad).toBe(404);
    // nothing under /mcp/<bad> is an endpoint, authenticated or not
    // (register/token are the real OAuth POST endpoints, so only GET is probed for those, below)
    if (bad !== 'register' && bad !== 'token') expect((await postMcp(request, bad, null, LIST)).status(), bad).toBe(404);
  }
  expect((await request.get(`/mcp/${slug}/deeper`)).status()).toBe(404);

  // register/token are the OAuth endpoints, never an upstream: wrong method is a 404, not a 401 challenge
  expect((await request.get('/mcp/register')).status()).toBe(404);
  expect((await request.get('/mcp/token')).status()).toBe(404);

  // /mcp (all upstreams in one, ADR-0017) challenges like any endpoint (TC-65 has the rest)
  const unified = await request.post('/mcp', { headers: { Accept: 'application/json, text/event-stream' }, data: LIST });
  expect(unified.status()).toBe(401);
  expect(unified.headers()['www-authenticate']).toContain(`resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`);
});

test('TC-11 Fremder oder unbekannter Slug -> 404, nie ein anderer Nutzer-Server', async ({ request }) => {
  const mine = uniqSlug('tc11m');
  const annas = uniqSlug('tc11a');
  const shared = uniqSlug('tc11s');
  await createUpstream(request, MATTHIAS, { slug: mine, description: 'Matthias privat' });
  await createUpstream(request, ANNA, { slug: annas, description: 'Annas privat' });
  await createUpstream(request, MATTHIAS, { slug: shared, description: 'Matthias gemeinsamer Slug' });
  await createUpstream(request, ANNA, { slug: shared, description: 'Anna gemeinsamer Slug' });

  const m = await runOAuthFlow(request, uniq('tc11m'), MATTHIAS);
  const a = await runOAuthFlow(request, uniq('tc11a'), ANNA);

  // own slug works, the other user's slug does not (both directions)
  expect((await postMcp(request, mine, m.accessToken, INITIALIZE)).status()).toBe(200);
  expect((await postMcp(request, annas, a.accessToken, INITIALIZE)).status()).toBe(200);
  for (const [slug, token] of [
    [annas, m.accessToken],
    [mine, a.accessToken],
    [uniqSlug('unknown'), m.accessToken],
  ] as const) {
    const res = await postMcp(request, slug, token, INITIALIZE);
    expect(res.status(), slug).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  }

  // the same slug for two users: each token reaches its own user's upstream
  const mi = await parseRpc(await postMcp(request, shared, m.accessToken, INITIALIZE));
  const ai = await parseRpc(await postMcp(request, shared, a.accessToken, INITIALIZE));
  expect(mi.result.instructions).toBe(`${PREFIX}\n\nMatthias gemeinsamer Slug`);
  expect(ai.result.instructions).toBe(`${PREFIX}\n\nAnna gemeinsamer Slug`);
});

test('TC-12 Roher MCP_TOKEN, manipulierte/abgelaufene/fremde Tokens und widerrufene Clients -> 401', async ({ request }) => {
  const slug = uniqSlug('tc12');
  await createUpstream(request, MATTHIAS, { slug });

  // raw secret as a bearer
  expect((await postMcp(request, slug, MCP_TOKEN, LIST)).status()).toBe(401);

  const m = await runOAuthFlow(request, uniq('tc12'), MATTHIAS);
  expect((await postMcp(request, slug, m.accessToken, LIST)).status()).toBe(200);

  // tampered payload (keeps the old signature)
  const [payload, sig] = m.accessToken.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const tampered = Buffer.from(JSON.stringify({ ...claims, uid: claims.uid + 1 }), 'utf8').toString('base64url');
  expect((await postMcp(request, slug, `${tampered}.${sig}`, LIST)).status()).toBe(401);
  expect((await postMcp(request, slug, `${payload}.AAAA`, LIST)).status()).toBe(401);
  expect((await postMcp(request, slug, 'garbage', LIST)).status()).toBe(401);

  // validly signed (we know the secret here) but expired
  const expired = forgeBlob({ ...claims, iat: nowSec() - 7200, exp: nowSec() - 3600 }, MCP_TOKEN);
  expect((await postMcp(request, slug, expired, LIST)).status()).toBe(401);
  // validly signed, unknown client
  expect((await postMcp(request, slug, forgeBlob({ ...claims, cid: 'nope' }, MCP_TOKEN), LIST)).status()).toBe(401);
  // validly signed, but a uid that is not the one the client is bound to
  const other = dbAll('select id from User where username = ?', 'anna')[0]?.id ?? claims.uid + 1000;
  expect((await postMcp(request, slug, forgeBlob({ ...claims, uid: other }, MCP_TOKEN), LIST)).status()).toBe(401);
  // a refresh token is not an access token
  expect((await postMcp(request, slug, m.refreshToken, LIST)).status()).toBe(401);
  // control: the genuine claims re-signed still pass (the forging helper is sound)
  expect((await postMcp(request, slug, forgeBlob(claims, MCP_TOKEN), LIST)).status()).toBe(200);

  // revoke: another user cannot, the owner can; takes effect on the next request
  const clients = await (await request.get('/api/mcp/clients', { headers: MATTHIAS })).json();
  const row = dbAll('select id from McpClient where clientId = ?', m.clientId)[0];
  expect(clients.map((c: any) => c.id)).toContain(row.id);
  expect((await request.delete(`/api/mcp/clients/${row.id}`, { headers: ANNA })).status()).toBe(404);
  expect((await postMcp(request, slug, m.accessToken, LIST)).status()).toBe(200);
  expect((await request.delete(`/api/mcp/clients/${row.id}`, { headers: MATTHIAS })).status()).toBe(204);
  expect((await postMcp(request, slug, m.accessToken, LIST)).status()).toBe(401);
  expect((await postMcp(request, slug, forgeBlob(claims, MCP_TOKEN), LIST)).status()).toBe(401);
  // ...and a revoked client's refresh token mints nothing
  const refresh = await request.post('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: m.refreshToken, client_id: m.clientId } });
  expect(refresh.status()).toBe(400);
  expect((await refresh.json()).error).toBe('invalid_grant');
});

test('TC-13 /oauth/authorize ohne Identität -> 401; gebundener Client lässt sich von anna nicht freigeben', async ({ request }) => {
  const clientId = await registerMcpClient(request, uniq('tc13'));
  const { challenge } = pkcePair();
  const params = authorizeParams(clientId, challenge, 'st-13');

  // consent page is behind the identity check: no Remote-User -> 401, no page
  const anon = await request.get(AUTHORIZE, { params, maxRedirects: 0 });
  expect(anon.status()).toBe(401);
  expect((await request.post(AUTHORIZE, { form: { ...params, csrf: 'x', decision: 'allow' }, maxRedirects: 0 })).status()).toBe(401);
  // a failed anonymous attempt did not bind the client
  expect(dbAll('select userId from McpClient where clientId = ?', clientId)[0].userId).toBeNull();

  // bind it to matthias
  const consent = await request.get(AUTHORIZE, { params, headers: MATTHIAS, maxRedirects: 0 });
  const csrf = await csrfFrom(consent);
  const approve = await request.post(AUTHORIZE, { form: { ...params, csrf, decision: 'allow' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(approve.status()).toBe(302);

  // anna: the consent page is refused (403, no csrf field, no button)...
  const annaGet = await request.get(AUTHORIZE, { params, headers: ANNA, maxRedirects: 0 });
  expect(annaGet.status()).toBe(403);
  const html = await annaGet.text();
  expect(html).toContain('anderen Person');
  expect(html).not.toContain('name="csrf"');
  // ...and a hand-crafted POST (valid csrf from matthias's own GET) is refused too, allow and deny alike
  const post = await request.post(AUTHORIZE, { form: { ...params, csrf, decision: 'allow' }, headers: ANNA, maxRedirects: 0 });
  expect(post.status()).toBe(403);
  expect(post.headers()['location']).toBeUndefined();
  const deny = await request.post(AUTHORIZE, { form: { ...params, csrf, decision: 'deny' }, headers: ANNA, maxRedirects: 0 });
  expect(deny.status()).toBe(403);
  expect(deny.headers()['location']).toBeUndefined();

  // binding unchanged; matthias can still re-approve his own client
  expect(dbAll('select u.username from McpClient c join User u on u.id = c.userId where c.clientId = ?', clientId)[0].username).toBe('matthias');
  const again = await request.post(AUTHORIZE, { form: { ...params, csrf, decision: 'allow' }, headers: MATTHIAS, maxRedirects: 0 });
  expect(again.status()).toBe(302);

  // a code issued to one client cannot be redeemed for another client_id
  const code = new URL(again.headers()['location']!).searchParams.get('code')!;
  const otherClient = await registerMcpClient(request, uniq('tc13b'));
  const { verifier } = pkcePair();
  const swapped = await exchangeCode(request, otherClient, code, verifier);
  expect(swapped.status()).toBe(400);
});

test('TC-10 Ohne MCP_TOKEN wird kein MCP gemountet (404, "MCP disabled"): fail closed', async ({ request }) => {
  // A second server on its own port, started without MCP_TOKEN (copied from haushalts-todos).
  const port = 3203;
  const env = { ...process.env, DATABASE_URL, PORT: String(port) };
  delete env.MCP_TOKEN;
  delete env.WEB_DIST;
  const child = spawn('node', [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  try {
    await expect
      .poll(async () => (await request.get(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.status(), {
        timeout: 20_000,
      })
      .toBe(200);
    const base = `http://127.0.0.1:${port}`;
    expect((await request.post(`${base}/mcp/anything`, { data: LIST })).status()).toBe(404);
    expect((await request.post(`${base}/mcp/register`, { data: { redirect_uris: ['https://example.com/callback'] } })).status()).toBe(404);
    expect((await request.get(`${base}/.well-known/oauth-authorization-server`)).status()).toBe(404);
    expect(log).toContain('MCP disabled');
  } finally {
    child.kill();
  }
});

test.describe('Einstellungen im Browser', () => {
  // The built server has no ingress, so the page's own fetches get matthias's identity here.
  test.use({ extraHTTPHeaders: MATTHIAS });

  test('TC-14 Einstellungen: nur eigene MCP-Clients, Endpunkt-URL je Upstream und für alle, Trennen mit Bestätigung', async ({
    page,
    request,
  }) => {
    const slug = uniqSlug('tc14');
    await createUpstream(request, MATTHIAS, { slug, name: 'Haushalt TC14' });
    const mine = uniq('Claude Matthias TC14');
    const theirs = uniq('Claude Anna TC14');
    const m = await runOAuthFlow(request, mine, MATTHIAS);
    await runOAuthFlow(request, theirs, ANNA);

    // /mcp/<slug> with a copy button on the upstream's own page
    await page.goto('/#/einstellungen');
    const item = page.locator('li.item[data-slug]', { hasText: 'Haushalt TC14' });
    await expect(item).toBeVisible();
    await item.getByRole('link', { name: 'Haushalt TC14 öffnen' }).click();
    await expect(page.getByRole('textbox', { name: /MCP-Adresse von Haushalt TC14/ })).toHaveValue(`${BASE_URL}/mcp/${slug}`);
    await expect(page.getByRole('button', { name: 'Adresse von Haushalt TC14 kopieren' })).toBeVisible();
    // /mcp for all (TC-68): a copy button above the list
    await page.goto('/#/einstellungen');
    await expect(page.getByRole('button', { name: 'Adresse für alle Upstreams kopieren' })).toBeVisible();

    // only the user's own clients
    const clients = page.getByRole('list', { name: 'MCP-Clients' });
    await expect(clients.getByText(mine)).toBeVisible();
    await expect(page.getByText(theirs)).toHaveCount(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    // rename, on the client's own page
    const row = clients.locator('li.item', { hasText: mine });
    await row.getByRole('link', { name: `${mine} öffnen` }).click();
    await page.getByRole('button', { name: 'Umbenennen' }).click();
    await page.getByRole('textbox', { name: 'Name des Clients' }).fill(mine + ' neu');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('heading', { name: mine + ' neu' })).toBeVisible();

    // revoke asks first; cancel keeps the client working, confirm cuts it off
    const revokeBtn = page.getByTestId('client-general').getByRole('button', { name: 'Trennen' });
    await revokeBtn.click();
    const confirm = page.getByRole('dialog', { name: /trennen\?/ });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole('heading', { name: mine + ' neu' })).toBeVisible();
    expect((await postMcp(request, slug, m.accessToken, LIST)).status()).toBe(200);

    await revokeBtn.click();
    await confirm.getByRole('button', { name: 'Trennen' }).click();
    await expect(page).toHaveURL(/#\/einstellungen$/);
    await expect(clients.getByText(mine + ' neu')).toHaveCount(0); // (the toast names it too, so scope to the list)
    expect((await postMcp(request, slug, m.accessToken, LIST)).status()).toBe(401);
  });
});
