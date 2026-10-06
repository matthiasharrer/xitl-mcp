// Push (ADR-0009): TC-32 (who gets what, payload), TC-33 (the service worker's
// actions make the app's request; body tap deep-links), TC-34 (Einstellungen:
// subscribe this device, test push) and the PWA shell. The server runs with
// PUSH_OUTBOX: nothing is really sent.
import { test, expect } from '@playwright/test';
import { ANNA, MATTHIAS, dbAll } from '../support/db.js';
import { BASE_URL } from '../support/paths.js';
import { fakeState } from '../support/upstream.js';
import { askUpstream, decide, lastAudit, startCall, waitPending } from '../support/approval.js';
import { fakeEndpoint, firstPushes, outbox, outboxLines, settle, subscribe, unsubscribe } from '../support/push.js';
import { loadServiceWorker } from '../support/sw.js';

test.use({ extraHTTPHeaders: {} });

test('TC-32 ask -> Push an jedes Gerät des Nutzers (nicht an andere), <= 4 KB, id/Upstream/Tool/Kurzfassung, keine Zugangsdaten', async ({ request }) => {
  const { up, token } = await askUpstream(request, 'tc32');
  const phone = await subscribe(request, MATTHIAS);
  const laptop = await subscribe(request, MATTHIAS);
  const annas = await subscribe(request, ANNA);
  try {
    const held = startCall(request, up.slug, token, 'add_item', { item: 'Eier', notiz: 'x'.repeat(20_000) });
    const p = await waitPending(request, up.id, 'add_item');
    await expect.poll(() => firstPushes(phone).length).toBe(1);
    await expect.poll(() => firstPushes(laptop).length).toBe(1);
    for (const ep of [phone, laptop]) {
      const [entry] = firstPushes(ep);
      expect(entry!.payload).toEqual({
        type: 'approval',
        id: p.id,
        upstream: up.name,
        tool: 'add_item',
        summary: expect.stringMatching(/^add_item: Eier, x+…$/),
        expiresAt: p.expiresAt,
      });
      expect(entry!.urgency).toBe('high');
      expect(entry!.ttl).toBeGreaterThan(0);
      expect(entry!.ttl).toBeLessThanOrEqual(5);
      expect(Buffer.byteLength(JSON.stringify(entry!.payload))).toBeLessThanOrEqual(4096);
      // no upstream credential, ever
      const line = outboxLines(ep).join('\n');
      for (const secret of (await fakeState(request, up.tenant)).tokens) expect(line).not.toContain(secret);
      expect(line).not.toContain(token);
    }
    expect(outbox(annas)).toEqual([]);

    // decided on the page -> a "resolved" push so the stale notification is replaced
    expect((await decide(request, p.id, { decision: 'approve' })).status()).toBe(200);
    await held;
    await expect.poll(() => firstPushes(phone).map((e) => e.payload.type)).toEqual(['approval', 'resolved']);
    expect(firstPushes(phone)[1]!.payload).toEqual({ type: 'resolved', id: p.id, outcome: 'approved' });
    await settle();
    expect(outbox(annas)).toEqual([]);
  } finally {
    for (const ep of [phone, laptop]) await unsubscribe(request, MATTHIAS, ep);
    await unsubscribe(request, ANNA, annas);
  }
});

test('TC-33 Service Worker: Aktion "Erlauben"/"Ablehnen" sendet die Anfrage der Seite (via push); Tippen öffnet die Freigabe', async ({ request }) => {
  const source = await (await request.get('/sw.js')).text();
  const { up, token } = await askUpstream(request, 'tc33');
  const ep = await subscribe(request, MATTHIAS);
  try {
    // The worker's exact request is replayed against the server, as Matthias
    // (the browser would add the Authelia cookie; the ingress the Remote-* headers).
    const sw = loadServiceWorker(source, BASE_URL, async (f) => {
      const res = await request.fetch(`${BASE_URL}${f.url}`, {
        method: f.init.method,
        headers: { ...f.init.headers, ...MATTHIAS, 'Sec-Fetch-Site': 'same-origin' },
        data: f.init.body,
        maxRedirects: 0,
      });
      return { ok: res.ok(), status: res.status(), type: 'basic' };
    });

    // 1) approve from the notification
    const held = startCall(request, up.slug, token, 'add_item', { item: 'Push-Eier' });
    const p = await waitPending(request, up.id, 'add_item');
    await expect.poll(() => firstPushes(ep).length).toBe(1);
    await sw.push(firstPushes(ep)[0]!.payload);
    const n = sw.shown.at(-1)!;
    expect(n.title).toBe('Freigabe nötig');
    expect(n.options.body).toContain(up.name);
    expect(n.options.body).toContain('add_item: Push-Eier');
    expect(n.options.tag).toBe(`approval-${p.id}`);
    expect(n.options.actions).toEqual([
      { action: 'approve', title: 'Erlauben' },
      { action: 'deny', title: 'Ablehnen' },
    ]);
    expect(n.options.data.url).toBe(`/#/freigabe/${p.id}`);

    const shownBefore = sw.shown.length;
    await sw.click(n, 'approve');
    expect(sw.fetches).toHaveLength(1);
    const f = sw.fetches[0]!;
    expect(f.url).toBe(`/api/approvals/${p.id}`);
    expect(f.init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'manual', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(f.init.body)).toEqual({ decision: 'approve', via: 'push' });
    expect(await held).toEqual({ content: [{ type: 'text', text: 'hinzugefügt: Push-Eier' }] });
    expect(lastAudit(up.id)).toMatchObject({ outcome: 'FORWARDED', decisionPath: 'policy:upstream-default+approved:push' });
    // done: the notification is gone, no outcome notification stays behind
    expect(n.closed).toBe(true);
    expect(sw.shown).toHaveLength(shownBefore);
    // decided from the notification: no extra "resolved" push
    await settle();
    expect(firstPushes(ep).map((e) => e.payload.type)).toEqual(['approval']);

    // 2) deny from the notification
    const held2 = startCall(request, up.slug, token, 'add_item', { item: 'Nein' });
    const p2 = await waitPending(request, up.id, 'add_item');
    await expect.poll(() => firstPushes(ep).length).toBe(2);
    await sw.push(firstPushes(ep)[1]!.payload);
    await sw.click(sw.shown.at(-1)!, 'deny');
    expect(JSON.parse(sw.fetches[1]!.init.body)).toEqual({ decision: 'deny', via: 'push' });
    expect((await held2).isError).toBe(true);
    expect(lastAudit(up.id)).toMatchObject({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+denied:push' });
    expect((await fakeState(request, up.tenant)).calls.add_item).toBe(1);

    // a second tap on a stale action: 409 -> "Nicht mehr offen", nothing happens
    await sw.click({ title: 'x', options: { data: { id: p2.id, url: `/#/freigabe/${p2.id}` } } }, 'approve');
    expect(sw.shown.at(-1)!.title).toBe('Nicht mehr offen');

    // 3) body tap (iPhone path): opens the approval page, no request
    const before = sw.fetches.length;
    await sw.click({ title: 'x', options: { data: { id: p2.id, url: `/#/freigabe/${p2.id}` } } });
    expect(sw.fetches).toHaveLength(before);
    expect(sw.opened).toEqual([`${BASE_URL}/#/freigabe/${p2.id}`]);

    // 4) Authelia session gone: the redirect is not followed, the user is sent to the app
    const expired = loadServiceWorker(source, BASE_URL, async () => ({ ok: false, status: 0, type: 'opaqueredirect' }));
    await expired.click({ title: 'x', options: { data: { id: p2.id, url: `/#/freigabe/${p2.id}` } } }, 'approve');
    expect(expired.shown.at(-1)!.title).toContain('anmelden');

    // 5) a "resolved" push closes what is still open for that call, shows nothing new
    const open2 = () => sw.shown.filter((x) => x.options?.tag === `approval-${p2.id}` && !x.closed);
    expect(open2().length).toBeGreaterThan(0);
    const before5 = sw.shown.length;
    await sw.push({ type: 'resolved', id: p2.id, outcome: 'expired' });
    expect(open2()).toEqual([]);
    expect(sw.shown).toHaveLength(before5);
  } finally {
    await unsubscribe(request, MATTHIAS, ep);
  }
});

test('TC-33 Push-Entscheidung nur für den eigenen Nutzer: anna mit der SW-Anfrage -> 404', async ({ request }) => {
  const { up, token } = await askUpstream(request, 'tc33x');
  const held = startCall(request, up.slug, token, 'add_item', { item: 'fremd' });
  const p = await waitPending(request, up.id, 'add_item');
  const res = await request.post(`/api/approvals/${p.id}`, {
    headers: { ...ANNA, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    data: JSON.stringify({ decision: 'approve', via: 'push' }),
  });
  expect(res.status()).toBe(404);
  // and a cross-site page can't make it either (CSRF guard)
  const csrf = await request.post(`/api/approvals/${p.id}`, {
    headers: { ...MATTHIAS, 'Sec-Fetch-Site': 'cross-site' },
    data: { decision: 'approve', via: 'push' },
  });
  expect(csrf.status()).toBe(403);
  await decide(request, p.id, { decision: 'deny' });
  expect((await held).isError).toBe(true);
  expect((await fakeState(request, up.tenant)).calls.add_item ?? 0).toBe(0);
});

test('PWA-Hülle: Manifest, Icons, Service Worker ohne fetch-Handler', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-cache');
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: 'xitl', display: 'standalone', start_url: '/' });
  const purposes = manifest.icons.map((i: any) => `${i.sizes}:${i.purpose}`);
  expect(purposes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  for (const src of [...manifest.icons.map((i: any) => i.src), '/apple-touch-icon.png']) {
    const img = await request.get(src);
    expect(img.status(), src).toBe(200);
    expect(img.headers()['content-type']).toBe('image/png');
    expect([...(await img.body()).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  }
  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toMatch(/javascript/);
  const source = await sw.text();
  expect(source).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
  expect(source).toMatch(/addEventListener\(\s*['"]push['"]/);
  expect(source).toMatch(/addEventListener\(\s*['"]notificationclick['"]/);
});

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: MATTHIAS });

  test('TC-34 Einstellungen: Benachrichtigungen aktivieren meldet dieses Gerät an; Test-Push landet im Outbox; ausschalten meldet ab', async ({ page, context }) => {
    const endpoint = fakeEndpoint();
    await context.grantPermissions(['notifications'], { origin: BASE_URL });
    // No real push service in the test browser, and the headless shell reports
    // notifications as "denied" whatever is granted: stand in for the
    // browser's Notification permission and PushManager (the server side and
    // the app code are real). A real device is a manual gate.
    await page.addInitScript((ep) => {
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      Notification.requestPermission = (async () => 'granted') as any;
      let sub: any = null;
      const make = () => ({ endpoint: ep, toJSON: () => ({ endpoint: ep, keys: { p256dh: 'test-p256dh', auth: 'test-auth' } }), unsubscribe: async () => ((sub = null), true) });
      PushManager.prototype.subscribe = async function () {
        sub = make();
        return sub;
      } as any;
      PushManager.prototype.getSubscription = async function () {
        return sub;
      } as any;
    }, endpoint);

    await page.goto('/#/einstellungen');
    const card = page.getByRole('region', { name: 'Benachrichtigungen' });
    const toggle = card.getByRole('checkbox', { name: 'Benachrichtigungen auf diesem Gerät' });
    await expect(toggle).not.toBeChecked();
    expect((await toggle.locator('xpath=ancestor::label').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.check();
    await expect(page.getByText('Benachrichtigungen auf diesem Gerät aktiv')).toBeVisible();
    await expect.poll(() => dbAll('select u.username from PushSubscription s join User u on u.id = s.userId where s.endpoint = ?', endpoint)).toEqual([{ username: 'matthias' }]);

    await card.getByRole('button', { name: 'Test-Push senden' }).click();
    await expect(page.getByText('Test gesendet')).toBeVisible();
    expect(outbox(endpoint).map((e) => e.payload)).toEqual([{ type: 'test', title: 'Test-Benachrichtigung', body: 'Push funktioniert.' }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await toggle.uncheck();
    await expect.poll(() => dbAll('select count(*) n from PushSubscription where endpoint = ?', endpoint)[0].n).toBe(0);
  });
});
