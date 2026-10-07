// Outbound address policy (ADR-0020): TC-77…81. The server runs with
// OUTBOUND_ALLOW_PRIVATE=127.0.0.1:3210 (playwright.config.ts): the fake
// upstream is allowed by that exact host:port, the sink (127.0.0.1:3211)
// stands in for "internal".
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { ANNA, MATTHIAS, createUpstream, dbAll, dbRun, uniq, uniqSlug } from '../support/db.js';
import { LIST, parseRpc, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { API_LOG, FAKE_HEADER_NAME, FAKE_HEADER_SECRET, FAKE_SINK } from '../support/paths.js';
import { callTool, connectViaApi, fakeMalice, fakeMcpUrl, fakeState, listTools, newTenant, sinkRequests } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

const BLOCKED_MESSAGE =
  'Diese Adresse liegt im internen Netz. xitl ruft sie nur auf, wenn du es für diesen Upstream ausdrücklich erlaubst.';
const BLOCKED = { error: BLOCKED_MESSAGE, code: 'internal_address' };
const flag = (id: number) => Boolean(row(id).allowInternal);
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
    expect(await res.json(), url).toEqual(BLOCKED);
    expect(dbAll('select id from Upstream where slug = ?', slug), url).toEqual([]);
  }

  const tenant = newTenant('tc77');
  const ok = await request.post('/api/upstreams', {
    headers: MATTHIAS,
    data: { name: 'Fake', slug: uniqSlug('tc77ok'), url: fakeMcpUrl(tenant) },
  });
  expect(ok.status(), await ok.text()).toBe(201);
  // allowed by the env list, so not "internal" for the check: no flag
  expect((await ok.json()).allowInternal).toBe(false);
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
  await expect(sheet.locator('.internal-hint')).toContainText(BLOCKED_MESSAGE);
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
    expect(await res.json()).toEqual(BLOCKED);
    expect(row(up.id).url).toBe(fakeMcpUrl(tenant));
    expect(flag(up.id)).toBe(false);
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
  expect(flag(up.id)).toBe(false); // unflagged: nobody confirmed it

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

/** The fake upstream under a name that is NOT on the env list: internal. */
const internalUrl = (tenant: string) => `http://localhost:3210/t/${tenant}/mcp`;

test('TC-82 Bestätigung pro Upstream: intern -> 400 internal_address; mit allowInternal -> gespeichert und erreichbar; öffentlich nie markiert; PATCH rechnet neu', async ({
  request,
}) => {
  const m = await runOAuthFlow(request, uniq('tc82'), MATTHIAS);
  const tenant = newTenant('tc82');
  const base = {
    name: 'Intern',
    url: internalUrl(tenant),
    auth: 'HEADER',
    headerName: FAKE_HEADER_NAME,
    headerValue: FAKE_HEADER_SECRET,
    defaultPolicy: 'ALLOW',
  };

  const refused = await request.post('/api/upstreams', { headers: MATTHIAS, data: { ...base, slug: uniqSlug('tc82') } });
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toEqual(BLOCKED);
  const notTrue = await request.post('/api/upstreams', { headers: MATTHIAS, data: { ...base, slug: uniqSlug('tc82'), allowInternal: false } });
  expect(await notTrue.json()).toEqual(BLOCKED);

  const created = await request.post('/api/upstreams', { headers: MATTHIAS, data: { ...base, slug: uniqSlug('tc82'), allowInternal: true } });
  expect(created.status(), await created.text()).toBe(201);
  const up = await created.json();
  expect(up.allowInternal).toBe(true);
  expect(flag(up.id)).toBe(true);
  // reaches the fake upstream under the internal name
  expect((await listTools(request, up.slug, m.accessToken)).map((t) => t.name)).toContain('list_items');
  expect((await callTool(request, up.slug, m.accessToken, 'list_items')).isError).toBeFalsy();
  expect((await fakeState(request, tenant)).calls.list_items).toBe(1);

  // a public URL never gets the flag, even when asked
  const pub = await request.post('/api/upstreams', {
    headers: MATTHIAS,
    data: { name: 'Öffentlich', slug: uniqSlug('tc82p'), url: 'https://example.com/mcp', allowInternal: true },
  });
  expect(pub.status()).toBe(201);
  expect((await pub.json()).allowInternal).toBe(false);

  // PATCH to another internal URL: without confirmation refused and unchanged, with it ok
  // (a HEADER upstream's new URL always comes with the value again, ADR-0021)
  const other = internalUrl(newTenant('tc82b'));
  const p1 = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { url: other } });
  expect(p1.status()).toBe(400);
  expect(await p1.json()).toEqual(BLOCKED);
  expect(row(up.id)).toMatchObject({ url: internalUrl(tenant) });
  expect(flag(up.id)).toBe(true);
  const p2 = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { url: other, allowInternal: true, headerValue: FAKE_HEADER_SECRET } });
  expect(p2.status()).toBe(200);
  expect((await p2.json()).allowInternal).toBe(true);
  expect(row(up.id).url).toBe(other);

  // other fields keep the flag
  const p3 = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { description: 'geändert' } });
  expect((await p3.json()).allowInternal).toBe(true);
  // same URL again without the confirmation: unchanged URL, flag kept
  const p4 = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { url: other } });
  expect(p4.status()).toBe(200);
  expect(flag(up.id)).toBe(true);

  // a public URL clears it, even when allowInternal is sent
  const p5 = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { url: 'https://example.com/mcp', allowInternal: true, headerValue: FAKE_HEADER_SECRET } });
  expect(p5.status()).toBe(200);
  expect((await p5.json()).allowInternal).toBe(false);
  expect(flag(up.id)).toBe(false);

  // another user: their own upstream needs their own confirmation; matthias's is not theirs to touch
  const anna = await request.post('/api/upstreams', { headers: ANNA, data: { ...base, slug: uniqSlug('tc82a') } });
  expect(await anna.json()).toEqual(BLOCKED);
  expect((await request.patch(`/api/upstreams/${up.id}`, { headers: ANNA, data: { url: other, allowInternal: true } })).status()).toBe(404);
  expect(flag(up.id)).toBe(false);

  for (const id of [up.id, (await pub.json()).id]) await request.delete(`/api/upstreams/${id}`, { headers: MATTHIAS });
});

test('TC-83 Markierter Upstream erreicht nur seinen eigenen Host:Port: Discovery zum Sink -> abgelehnt, beim Sink nichts; ohne Malice verbindet er', async ({
  request,
}) => {
  const createFlagged = async (tenant: string) => {
    const res = await request.post('/api/upstreams', {
      headers: MATTHIAS,
      data: { name: 'Intern OAuth', slug: uniqSlug('tc83'), url: internalUrl(tenant), defaultPolicy: 'ALLOW', allowInternal: true },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: number; slug: string };
  };

  // discovery names an AS on another internal host:port -> refused
  const tenant = newTenant('tc83');
  const up = await createFlagged(tenant);
  await fakeMalice(request, tenant, { asOnSink: true });
  const res = await request.post(`/api/upstreams/${up.id}/connect`, { headers: MATTHIAS });
  const text = await res.text();
  expect(res.status(), text).toBe(502);
  expect(JSON.parse(text).authorizationUrl).toBeUndefined();
  expect(await sinkRequests(request, tenant)).toEqual([]);
  expect(row(up.id)).toMatchObject({ status: 'NOT_CONNECTED', accessToken: null, oauthClient: null });

  // control: the whole OAuth flow on its own host:port works (discovery, DCR, token, MCP)
  const okTenant = newTenant('tc83ok');
  const ok = await createFlagged(okTenant);
  await connectViaApi(request, ok.id);
  expect(row(ok.id).status).toBe('CONNECTED');
  const m = await runOAuthFlow(request, uniq('tc83'), MATTHIAS);
  expect((await listTools(request, ok.slug, m.accessToken)).map((t) => t.name)).toContain('list_items');
  expect((await callTool(request, ok.slug, m.accessToken, 'list_items')).isError).toBeFalsy();
  expect((await fakeState(request, okTenant)).calls.list_items).toBe(1);

  for (const id of [up.id, ok.id]) await request.delete(`/api/upstreams/${id}`, { headers: MATTHIAS });
});

test('TC-84 Formular am Handy: interne Adresse -> Hinweis + "Trotzdem erlauben" sichtbar; Tippen speichert; Liste zeigt "intern"', async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders(MATTHIAS);
  await page.goto('/#/einstellungen');
  await page.getByRole('button', { name: 'Upstream hinzufügen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Upstream hinzufügen' });
  const name = uniq('Intern TC84').replace(/[^A-Za-z0-9 -]/g, '');
  await sheet.getByLabel('Name').fill(name);
  const url = internalUrl(newTenant('tc84'));
  await sheet.getByLabel('URL').fill(url);
  await sheet.getByRole('button', { name: 'Hinzufügen' }).click();

  const hint = sheet.locator('.internal-hint');
  const allow = sheet.getByRole('button', { name: 'Trotzdem erlauben' });
  await expect(hint).toContainText('intern');
  await expect(hint).toContainText('nur, wenn du dem Dienst vertraust');
  // fully visible: inside the sheet's scroll area and above the sticky footer
  // (1 px tolerance for subpixel layout)
  await expect
    .poll(() =>
      hint.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const body = el.closest('.sheet-body')!.getBoundingClientRect();
        const foot = el.closest('form')!.querySelector('.sheet-foot')!.getBoundingClientRect();
        return r.top >= body.top - 1 && r.bottom <= Math.min(body.bottom, foot.top) + 1 && r.bottom <= innerHeight + 1;
      }),
    )
    .toBe(true);
  await expect(allow).toBeInViewport();
  // the sticky footer doesn't cover it
  const covered = await allow.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !el.contains(hit);
  });
  expect(covered).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

  // editing the URL clears the hint
  await sheet.getByLabel('URL').fill(url + 'x');
  await expect(hint).toHaveCount(0);
  await sheet.getByLabel('URL').fill(url);
  await sheet.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(allow).toBeVisible();

  await allow.click();
  await expect(sheet).toBeHidden();
  const item = page.locator('li.item[data-slug]', { hasText: name });
  await expect(item).toBeVisible();
  await expect(item.locator('.badge', { hasText: 'intern' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

  const saved = dbAll('select id, allowInternal from Upstream where name = ?', name);
  expect(saved).toHaveLength(1);
  expect(saved[0].allowInternal).toBe(1);
  await request.delete(`/api/upstreams/${saved[0].id}`, { headers: MATTHIAS });
});
