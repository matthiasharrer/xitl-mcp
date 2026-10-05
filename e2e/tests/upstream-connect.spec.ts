// Upstream connection (ADR-0013): TC-15…TC-18 against the fake upstream.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { ANNA, MATTHIAS, createUpstream, dbAll, uniq, uniqSlug } from '../support/db.js';
import { API_LOG, FAKE_HEADER_NAME, FAKE_HEADER_SECRET, FAKE_UPSTREAM } from '../support/paths.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import {
  callTool,
  connectViaApi,
  connectedUpstream,
  fakeControl,
  fakeMcpUrl,
  fakeState,
  listTools,
  mcp,
  newTenant,
  startConnect,
} from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

/** Every tenant this file used; TC-18 checks all their tokens at the end. */
const tenants: string[] = [];
/** Every xitl response body (API, MCP) this file saw. */
const seen: string[] = [];
const keep = async (res: { text(): Promise<string> }) => {
  const t = await res.text();
  seen.push(t);
  return t;
};

const SECRET_KEYS = ['accessToken', 'refreshToken', 'headerValue', 'oauthClient', 'pendingAuth', 'codeVerifier'];

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: MATTHIAS });

  test('TC-15 Einstellungen -> Verbinden -> (Fake-AS) -> zurück, Status "Verbunden"; Tokens nur in der DB', async ({ page, request }) => {
    const tenant = newTenant('tc15');
    tenants.push(tenant);
    const name = uniq('Fake TC15');
    const up = await createUpstream(request, MATTHIAS, { name, url: fakeMcpUrl(tenant) });

    await page.goto('/#/einstellungen');
    const item = page.locator('li.item', { hasText: name });
    await expect(item.getByText('Nicht verbunden')).toBeVisible();
    await item.getByRole('button', { name: 'Verbinden' }).click();

    // fake AS auto-approves -> callback -> back on Einstellungen
    await expect(page).toHaveURL(/#\/einstellungen$/);
    await expect(item.getByText('Verbunden', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('verbunden');
    await expect(item.getByRole('button', { name: 'Neu verbinden' })).toBeVisible();

    const row = dbAll('select status, accessToken, refreshToken, tokenExpiresAt, pendingAuth, oauthClient from Upstream where id = ?', up.id)[0];
    expect(row.status).toBe('CONNECTED');
    expect(row.accessToken).toBeTruthy();
    expect(row.refreshToken).toBeTruthy();
    expect(row.tokenExpiresAt).toBeTruthy();
    expect(row.pendingAuth).toBeNull(); // single use: consumed
    expect(JSON.parse(row.oauthClient).info.client_id).toBeTruthy();

    // no API response carries them
    const state = await fakeState(request, tenant);
    expect(state.tokens.length).toBeGreaterThan(0);
    for (const url of ['/api/upstreams', `/api/upstreams/${up.id}`, `/api/upstreams/${up.id}/tools`]) {
      const text = await keep(await request.get(url, { headers: MATTHIAS }));
      for (const tok of state.tokens) expect(text).not.toContain(tok);
      for (const key of SECRET_KEYS) expect(text).not.toContain(key);
    }
  });

  test('TC-15 HEADER/NONE: sofort "Verbunden", kein Verbinden-Knopf; der Header wird injiziert', async ({ page, request }) => {
    const tenant = newTenant('tc15h');
    tenants.push(tenant);
    const headerName = uniq('Header TC15');
    const header = await createUpstream(request, MATTHIAS, {
      name: headerName,
      url: fakeMcpUrl(tenant),
      auth: 'HEADER',
      headerName: FAKE_HEADER_NAME,
      headerValue: FAKE_HEADER_SECRET,
      defaultPolicy: 'ALLOW',
    });
    const noneName = uniq('None TC15');
    const none = await createUpstream(request, MATTHIAS, { name: noneName, url: `${FAKE_UPSTREAM}/unused/tc15-none/mcp`, auth: 'NONE' }); // allowed address (ADR-0020), answers 404
    for (const id of [header.id, none.id]) {
      expect((await (await request.get(`/api/upstreams/${id}`, { headers: MATTHIAS })).json()).status).toBe('CONNECTED');
      const res = await request.post(`/api/upstreams/${id}/connect`, { headers: MATTHIAS });
      expect(res.status()).toBe(400);
    }
    // switching an OAUTH upstream to HEADER makes it CONNECTED, back to OAUTH NOT_CONNECTED
    const sw = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(tenant) });
    const toHeader = await request.patch(`/api/upstreams/${sw.id}`, { headers: MATTHIAS, data: { auth: 'HEADER', headerName: 'X-K', headerValue: 'v' } });
    expect((await toHeader.json()).status).toBe('CONNECTED');
    const back = await request.patch(`/api/upstreams/${sw.id}`, { headers: MATTHIAS, data: { auth: 'OAUTH' } });
    expect((await back.json()).status).toBe('NOT_CONNECTED');

    await page.goto('/#/einstellungen');
    for (const n of [headerName, noneName]) {
      const item = page.locator('li.item', { hasText: n });
      await expect(item.getByText('Verbunden', { exact: true })).toBeVisible();
      await expect(item.getByRole('button', { name: /Verbinden/ })).toHaveCount(0);
      await expect(item.getByRole('link', { name: /Regeln/ })).toBeVisible();
    }

    // the proxy injects the header credential (the fake only answers with it)
    const m = await runOAuthFlow(request, uniq('tc15h'), MATTHIAS);
    const tools = await listTools(request, header.slug, m.accessToken);
    expect(tools.map((t) => t.name)).toContain('list_items');
    expect((await fakeState(request, tenant)).authSeen).toContain('header');
  });
});

test('TC-16 Callback ist an den startenden Nutzer gebunden; unbekannter/benutzter state -> 400', async ({ request }) => {
  const tenant = newTenant('tc16');
  tenants.push(tenant);
  const up = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(tenant) });

  // anna cannot even start it on matthias's upstream
  expect((await request.post(`/api/upstreams/${up.id}/connect`, { headers: ANNA })).status()).toBe(404);

  const callback = await startConnect(request, up.id, MATTHIAS);
  const state = new URL(callback).searchParams.get('state')!;
  expect(state.startsWith(`${up.id}.`)).toBe(true);
  expect(dbAll('select pendingAuth from Upstream where id = ?', up.id)[0].pendingAuth).toBeTruthy();

  // the right state, presented as anna -> 400, nothing stored, nothing consumed
  const asAnna = await request.get(callback, { headers: ANNA, maxRedirects: 0 });
  expect(asAnna.status()).toBe(400);
  expect(asAnna.headers()['location']).toBeUndefined();
  let row = dbAll('select status, accessToken, pendingAuth from Upstream where id = ?', up.id)[0];
  expect(row.status).toBe('NOT_CONNECTED');
  expect(row.accessToken).toBeNull();
  expect(row.pendingAuth).toBeTruthy();
  // anna's own upstreams were not touched either
  expect(dbAll("select count(*) n from Upstream u join User x on x.id = u.userId where x.username = 'anna' and u.accessToken is not null")[0].n).toBe(0);

  // without identity -> 401 (it is under /api)
  expect((await request.get(callback, { maxRedirects: 0 })).status()).toBe(401);

  // unknown / malformed / wrong-secret states -> 400
  const url = new URL(callback);
  for (const bad of [`${up.id}.${'A'.repeat(43)}`, 'garbage', '', `999999.${'b'.repeat(43)}`]) {
    url.searchParams.set('state', bad);
    const r = await request.get(url.href, { headers: MATTHIAS, maxRedirects: 0 });
    expect(r.status(), bad).toBe(400);
  }
  expect(dbAll('select pendingAuth from Upstream where id = ?', up.id)[0].pendingAuth).toBeTruthy();

  // the right user -> connected
  const ok = await request.get(callback, { headers: MATTHIAS, maxRedirects: 0 });
  expect(ok.status()).toBe(302);
  expect(ok.headers()['location']).toBe(`/#/einstellungen?verbunden=${up.id}`);
  row = dbAll('select status, accessToken, pendingAuth from Upstream where id = ?', up.id)[0];
  expect(row.status).toBe('CONNECTED');
  expect(row.pendingAuth).toBeNull();
  const firstToken = row.accessToken;

  // replay of the used state -> 400, tokens unchanged
  const replay = await request.get(callback, { headers: MATTHIAS, maxRedirects: 0 });
  expect(replay.status()).toBe(400);
  expect(dbAll('select accessToken from Upstream where id = ?', up.id)[0].accessToken).toBe(firstToken);

  // the AS refusing -> back to Einstellungen with an error, not connected anew
  const callback2 = await startConnect(request, up.id, MATTHIAS);
  const denied = new URL(callback2);
  denied.searchParams.delete('code');
  denied.searchParams.set('error', 'access_denied');
  const d = await request.get(denied.href, { headers: MATTHIAS, maxRedirects: 0 });
  expect(d.status()).toBe(302);
  expect(d.headers()['location']).toBe(`/#/einstellungen?verbindung=abgelehnt&upstream=${up.id}`);
});

test.describe('Ablauf und Neu verbinden', () => {
  test.use({ extraHTTPHeaders: MATTHIAS });

  test('TC-17 Abgelaufenes Token -> transparenter Refresh; Refresh abgelehnt -> "Neu verbinden nötig" + isError', async ({ page, request }) => {
    // short TTL from the start: every proxied call is within 60 s of expiry
    const name = uniq('Fake TC17');
    const up = await connectedUpstream(request, 'tc17', { name, defaultPolicy: 'ALLOW' }, MATTHIAS, (t) =>
      fakeControl(request, t, 'config', { accessTtl: 1 }),
    );
    tenants.push(up.tenant);
    const m = await runOAuthFlow(request, uniq('tc17'), MATTHIAS);

    await listTools(request, up.slug, m.accessToken); // records the tools (all acknowledged: first list)
    const before = (await fakeState(request, up.tenant)).refreshCount;
    const r1 = await callTool(request, up.slug, m.accessToken, 'list_items');
    expect(r1.isError).toBeFalsy();
    expect(r1.content[0]!.text).toBe('Milch, Brot');
    expect((await fakeState(request, up.tenant)).refreshCount).toBeGreaterThan(before);

    // long TTL now, but the upstream forgets every token: 401 -> one refresh -> retry
    await fakeControl(request, up.tenant, 'config', { accessTtl: 3600 });
    await callTool(request, up.slug, m.accessToken, 'list_items'); // picks up a 3600 s token
    await fakeControl(request, up.tenant, 'expire-access');
    const mid = (await fakeState(request, up.tenant)).refreshCount;
    const r2 = await callTool(request, up.slug, m.accessToken, 'list_items');
    expect(r2.isError).toBeFalsy();
    expect((await fakeState(request, up.tenant)).refreshCount).toBe(mid + 1);
    expect(dbAll('select status from Upstream where id = ?', up.id)[0].status).toBe('CONNECTED');

    // refresh rejected -> NEEDS_RECONNECT, tokens dropped, isError for the agent
    await fakeControl(request, up.tenant, 'config', { rejectRefresh: true });
    await fakeControl(request, up.tenant, 'expire-access');
    const callsBefore = (await fakeState(request, up.tenant)).calls.list_items ?? 0;
    const callRes = await mcp(request, up.slug, m.accessToken, 'tools/call', { name: 'list_items', arguments: {} });
    seen.push(JSON.stringify(callRes));
    expect(callRes.result.isError).toBe(true);
    expect(callRes.result.content[0].text).toContain(`Upstream „${name}“ muss in xitl neu verbunden werden.`);
    expect((await fakeState(request, up.tenant)).calls.list_items ?? 0).toBe(callsBefore);
    const row = dbAll('select status, accessToken, refreshToken from Upstream where id = ?', up.id)[0];
    expect(row).toEqual({ status: 'NEEDS_RECONNECT', accessToken: null, refreshToken: null });
    const audit = dbAll('select outcome from AuditEntry where upstreamId = ? order by id desc limit 1', up.id)[0];
    expect(audit.outcome).toBe('UPSTREAM_ERROR');
    // tools/list no longer contacts the upstream; the next call says the same
    expect(await listTools(request, up.slug, m.accessToken)).toEqual([]);
    const again = await callTool(request, up.slug, m.accessToken, 'list_items');
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain('muss in xitl neu verbunden werden');

    // the UI offers "Neu verbinden", which works again
    await fakeControl(request, up.tenant, 'config', { rejectRefresh: false });
    await page.goto('/#/einstellungen');
    const item = page.locator('li.item', { hasText: name });
    await expect(item.getByText('Neu verbinden nötig')).toBeVisible();
    await item.getByRole('button', { name: 'Neu verbinden' }).click();
    await expect(item.getByText('Verbunden', { exact: true })).toBeVisible();
    const r3 = await callTool(request, up.slug, m.accessToken, 'list_items');
    expect(r3.isError).toBeFalsy();
  });
});

test('TC-18 Kein Upstream-Token in API-Antworten, MCP-Ergebnissen, MCP-Fehlern oder im API-Log', async ({ request }) => {
  const up = await connectedUpstream(request, 'tc18', { defaultPolicy: 'ALLOW' });
  tenants.push(up.tenant);
  const m = await runOAuthFlow(request, uniq('tc18'), MATTHIAS);
  // a tool that echoes the credential it was called with: xitl must scrub it
  await fakeControl(request, up.tenant, 'tools', { name: 'leak_token', description: 'echoes the bearer' });
  seen.push(JSON.stringify(await mcp(request, up.slug, m.accessToken, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' },
  })));
  seen.push(JSON.stringify(await listTools(request, up.slug, m.accessToken)));
  await request.patch(`/api/upstreams/${up.id}/tools/${dbAll('select id from KnownTool where upstreamId = ? and name = ?', up.id, 'leak_token')[0].id}`, {
    headers: MATTHIAS,
    data: { policy: 'ALLOW' },
  });
  const leak = await callTool(request, up.slug, m.accessToken, 'leak_token');
  seen.push(JSON.stringify(leak));
  expect(leak.content[0]!.text).toBe('I was called with [xitl: entfernt]');
  // a HEADER upstream's echoed secret is scrubbed too
  const htenant = newTenant('tc18h');
  tenants.push(htenant);
  const h = await createUpstream(request, MATTHIAS, {
    slug: uniqSlug('tc18h'), url: fakeMcpUrl(htenant), auth: 'HEADER', headerName: FAKE_HEADER_NAME, headerValue: FAKE_HEADER_SECRET, defaultPolicy: 'ALLOW',
  });
  await fakeControl(request, htenant, 'tools', { name: 'leak_token' });
  await listTools(request, h.slug, m.accessToken);
  const hleak = await callTool(request, h.slug, m.accessToken, 'leak_token');
  seen.push(JSON.stringify(hleak));
  expect(JSON.stringify(hleak)).not.toContain(FAKE_HEADER_SECRET);

  // error paths: refresh rejected (MCP error result + list error), connect errors
  await fakeControl(request, up.tenant, 'config', { rejectRefresh: true });
  await fakeControl(request, up.tenant, 'expire-access');
  seen.push(JSON.stringify(await mcp(request, up.slug, m.accessToken, 'tools/call', { name: 'list_items', arguments: {} })));
  for (const url of ['/api/upstreams', `/api/upstreams/${up.id}`, `/api/upstreams/${up.id}/tools`, `/api/upstreams/${h.id}`]) {
    await keep(await request.get(url, { headers: MATTHIAS }));
  }
  await keep(await request.post(`/api/upstreams/${h.id}/tools/refresh`, { headers: MATTHIAS }));

  // every token any tenant of this file was issued
  const secrets = [FAKE_HEADER_SECRET];
  for (const t of tenants) secrets.push(...(await fakeState(request, t)).tokens);
  expect(secrets.length).toBeGreaterThan(5);
  const log = fs.readFileSync(API_LOG, 'utf8');
  expect(log.length).toBeGreaterThan(0);
  for (const s of secrets) {
    expect(log, 'API-Log').not.toContain(s);
    for (const body of seen) expect(body).not.toContain(s);
  }
});
