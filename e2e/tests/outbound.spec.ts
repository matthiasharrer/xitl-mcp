// Outbound address policy (ADR-0020): TC-77…81. The server runs with
// OUTBOUND_ALLOW_PRIVATE=127.0.0.1:3210 (playwright.config.ts): the fake
// upstream is allowed by that exact host:port, the sink (127.0.0.1:3211)
// stands in for "internal".
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { MATTHIAS, createUpstream, dbAll, dbRun, uniq, uniqSlug } from '../support/db.js';
import { LIST, parseRpc, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { API_LOG, FAKE_HEADER_NAME, FAKE_HEADER_SECRET, FAKE_SINK } from '../support/paths.js';
import { callTool, fakeMalice, fakeMcpUrl, fakeState, newTenant, sinkRequests } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

const BLOCKED_MESSAGE = 'Diese Adresse ist intern und für Upstreams nicht freigegeben.';
const row = (id: number) => dbAll('select * from Upstream where id = ?', id)[0];

const BLOCKED_URLS = [
  'http://127.0.0.1:3211/mcp',
  'http://localhost:3210/mcp', // the name isn't listed, though the address/port is
  'http://[::1]:3211/',
  'http://[::ffff:127.0.0.1]:3211/',
  'http://2130706433:3211/',
  'http://169.254.169.254/',
  'http://10.0.0.1/',
  'http://192.168.1.1/',
];

test('TC-77 Upstream mit interner Adresse anlegen -> 400 (deutsch), keine Zeile; die erlaubte Fake-Adresse -> 201; Meldung im Formular', async ({
  request,
  page,
}) => {
  for (const url of BLOCKED_URLS) {
    const slug = uniqSlug('tc77');
    const res = await request.post('/api/upstreams', { headers: MATTHIAS, data: { name: 'Intern', slug, url } });
    expect(res.status(), url).toBe(400);
    expect((await res.json()).error, url).toBe(BLOCKED_MESSAGE);
    expect(dbAll('select id from Upstream where slug = ?', slug), url).toEqual([]);
  }

  const tenant = newTenant('tc77');
  const ok = await request.post('/api/upstreams', {
    headers: MATTHIAS,
    data: { name: 'Fake', slug: uniqSlug('tc77ok'), url: fakeMcpUrl(tenant) },
  });
  expect(ok.status(), await ok.text()).toBe(201);
  await request.delete(`/api/upstreams/${(await ok.json()).id}`, { headers: MATTHIAS });

  // the same message in the form, on a phone (390×844 from the config)
  await page.setExtraHTTPHeaders(MATTHIAS);
  await page.goto('/#/einstellungen');
  await page.getByRole('button', { name: 'Upstream hinzufügen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Upstream hinzufügen' });
  const name = uniq('Intern TC77').replace(/[^A-Za-z0-9 -]/g, '');
  await sheet.getByLabel('Name').fill(name);
  await sheet.getByLabel('URL').fill('http://127.0.0.1:3211/mcp');
  await sheet.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(sheet.getByRole('alert')).toHaveText(BLOCKED_MESSAGE);
  await expect(sheet).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  expect(dbAll('select id from Upstream where name = ?', name)).toEqual([]);
});

test('TC-78 PATCH auf eine interne Adresse -> 400, die alte URL bleibt', async ({ request }) => {
  const tenant = newTenant('tc78');
  const up = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(tenant) });
  for (const url of ['http://127.0.0.1:3211/mcp', 'http://localhost:3210/mcp', 'http://169.254.169.254/latest/meta-data']) {
    const res = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { url } });
    expect(res.status(), url).toBe(400);
    expect((await res.json()).error).toBe(BLOCKED_MESSAGE);
    expect(row(up.id).url).toBe(fakeMcpUrl(tenant));
  }
  // an allowed URL is still accepted
  const other = fakeMcpUrl(newTenant('tc78b'));
  const res = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { url: other } });
  expect(res.status()).toBe(200);
  expect(row(up.id).url).toBe(other);
  await request.delete(`/api/upstreams/${up.id}`, { headers: MATTHIAS });
});

test('TC-79 Discovery nach innen gelenkt (AS auf dem Sink) -> Verbinden scheitert deutsch, beim Sink kommt nichts an', async ({ request }) => {
  const tenant = newTenant('tc79');
  const up = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(tenant), defaultPolicy: 'ALLOW' });
  await fakeMalice(request, tenant, { asOnSink: true });

  const res = await request.post(`/api/upstreams/${up.id}/connect`, { headers: MATTHIAS });
  const text = await res.text();
  expect(res.status(), text).toBe(502);
  const body = JSON.parse(text);
  expect(body.authorizationUrl).toBeUndefined();
  expect(body.error).toMatch(/Upstream|Anmelde|Verbindung/);
  expect(text).not.toContain(FAKE_SINK);

  expect(await sinkRequests(request, tenant)).toEqual([]);
  expect(row(up.id)).toMatchObject({ status: 'NOT_CONNECTED', pendingAuth: null, accessToken: null, oauthClient: null });
  expect(fs.readFileSync(API_LOG, 'utf8')).toMatch(/blocked request to host 127\.0\.0\.1\b/);
  await request.delete(`/api/upstreams/${up.id}`, { headers: MATTHIAS });
});

test('TC-80 Durchsetzung beim Request (ohne Speicher-Prüfung): Upstream auf localhost -> generischer Fehler, 0 Aufrufe, kein Secret, Log nur mit Hostname', async ({
  request,
}) => {
  const m = await runOAuthFlow(request, uniq('tc80'), MATTHIAS);
  const tenant = newTenant('tc80');
  const up = await createUpstream(request, MATTHIAS, {
    url: fakeMcpUrl(tenant),
    auth: 'HEADER',
    headerName: FAKE_HEADER_NAME,
    headerValue: FAKE_HEADER_SECRET,
    defaultPolicy: 'ALLOW',
  });
  // Simulates DNS changing after the save: the row now names a host that
  // resolves to a blocked address (and isn't on the exception list).
  const internalUrl = `http://localhost:3210/t/${tenant}/mcp`;
  dbRun('update Upstream set url = ? where id = ?', internalUrl, up.id);

  const listRes = await postMcp(request, up.slug, m.accessToken, LIST);
  const listText = await listRes.text();
  const list = await parseRpc(listRes);
  expect(list.error, listText).toBeTruthy();

  const call = await callTool(request, up.slug, m.accessToken, 'list_items');
  expect(call.isError).toBe(true);

  for (const text of [listText, JSON.stringify(call)]) {
    expect(text).not.toContain(FAKE_HEADER_SECRET);
    expect(text).not.toContain('localhost');
    expect(text).not.toContain(tenant);
  }
  const state = await fakeState(request, tenant);
  expect(state.mcpRequests).toBe(0);
  expect(state.calls).toEqual({});

  const log = fs.readFileSync(API_LOG, 'utf8');
  expect(log).not.toContain(FAKE_HEADER_SECRET);
  const blockedLines = log.split('\n').filter((l) => l.includes('blocked') && l.includes('localhost'));
  expect(blockedLines.length).toBeGreaterThan(0);
  for (const l of blockedLines) {
    expect(l).not.toContain(tenant);
    expect(l).not.toContain('/mcp');
  }
  await request.delete(`/api/upstreams/${up.id}`, { headers: MATTHIAS });
});

test('TC-81 Push-Abo mit interner Adresse -> 400; ein öffentlicher Endpunkt geht weiter', async ({ request }) => {
  const user = { 'Remote-User': 'outbound-push', 'Remote-Name': 'Otto' };
  const keys = { p256dh: 'dummy-p256dh', auth: 'dummy-auth' };
  for (const endpoint of ['https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://localhost/x']) {
    const res = await request.post('/api/push/subscriptions', { headers: user, data: { endpoint, keys } });
    expect(res.status(), endpoint).toBe(400);
    expect(dbAll('select id from PushSubscription where endpoint = ?', endpoint)).toEqual([]);
  }
  const endpoint = `https://fcm.googleapis.com/fcm/send/x-${crypto.randomBytes(6).toString('hex')}`;
  const ok = await request.post('/api/push/subscriptions', { headers: user, data: { endpoint, keys } });
  expect(ok.status(), await ok.text()).toBe(201);
  expect((await request.delete('/api/push/subscriptions', { headers: user, data: { endpoint } })).status()).toBe(204);
});
