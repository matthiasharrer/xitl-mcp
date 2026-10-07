// "Läuft gerade" (Matthias 2026-10-07): TC-178…183. Overview of the user's
// live Zeitfreigaben, Sperren and paused accesses at the top of Freigaben.
// Units: apps/web/src/lib/pauses.test.ts (wording).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, dbRun, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { connectedUpstream } from '../support/upstream.js';
import { decide, openStream, pendingList, startCall } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Läuft ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Läuft ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await runOAuthFlow(request, uniq(`${prefix} A`), user);
  const B = await runOAuthFlow(request, uniq(`${prefix} B`), user);
  const rowId = (clientId: string) => dbAll('select id, name from McpClient where clientId = ?', clientId)[0] as { id: number; name: string };
  return { user, up, A: { token: A.accessToken, ...rowId(A.clientId) }, B: { token: B.accessToken, ...rowId(B.clientId) } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function heldOf(request: APIRequestContext, ctx: Ctx, tool: string) {
  let found: any;
  await expect
    .poll(async () => {
      found = (await pendingList(request, ctx.user)).find((p) => p.upstream.id === ctx.up.id && p.tool === tool);
      return !!found;
    }, { timeout: 6000, intervals: [50, 100, 200] })
    .toBe(true);
  return found;
}
/** A 15-min Zeitfreigabe on add_item for access A (+ purpose). */
async function grantAllow(request: APIRequestContext, ctx: Ctx, purpose?: string) {
  const c = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'x' });
  const p = await heldOf(request, ctx, 'add_item');
  expect((await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool', ...(purpose ? { purpose } : {}) }, ctx.user)).status()).toBe(200);
  await c;
}
/** A 1-hour Sperre on the whole upstream for access B. */
async function setDeny(request: APIRequestContext, ctx: Ctx) {
  const c = startCall(request, ctx.up.slug, ctx.B.token, 'list_items', {});
  const p = await heldOf(request, ctx, 'list_items');
  expect((await decide(request, p.id, { decision: 'deny', snoozeMinutes: 60, snoozeScope: 'upstream' }, ctx.user)).status()).toBe(200);
  await c;
}
const pauseClient = (request: APIRequestContext, ctx: Ctx, id: number, paused: boolean) =>
  request.patch(`/api/mcp/clients/${id}`, { headers: ctx.user, data: { paused } });
const snoozes = (ctx: Ctx) => dbAll('select * from Snooze where upstreamId = ? order by id', ctx.up.id);
const running = async (request: APIRequestContext, user: Identity) => (await request.get('/api/running', { headers: user })).json();

/** Everything at once: allow (15 min), deny (60 min), a third access paused. */
async function full(request: APIRequestContext, prefix: string) {
  const ctx = await setup(request, prefix);
  await grantAllow(request, ctx, 'Einkauf');
  await setDeny(request, ctx);
  const C = await runOAuthFlow(request, uniq(`${prefix} C`), ctx.user);
  const cRow = dbAll('select id, name from McpClient where clientId = ?', C.clientId)[0] as { id: number; name: string };
  expect((await pauseClient(request, ctx, cRow.id, true)).status()).toBe(200);
  return { ...ctx, C: cRow };
}

test.describe('TC-178 Zusammenfassung', () => {
  test('nichts aktiv → kein Block; sonst eine Zeile, eingeklappt, Zustand pro Gerät gemerkt', async ({ request, page }) => {
    const ctx0 = await setup(request, 'run178e');
    await page.setExtraHTTPHeaders(ctx0.user);
    await page.goto('/');
    await expect(page.getByText('Keine offenen Freigaben.')).toBeVisible();
    await expect(page.getByTestId('running')).toHaveCount(0);

    const ctx = await full(request, 'run178');
    await page.setExtraHTTPHeaders(ctx.user);
    await page.evaluate(() => localStorage.removeItem('xitl.running.open'));
    await page.goto('/');
    const head = page.getByTestId('running-summary');
    await expect(head).toHaveText(/^Läuft gerade: 1 Zeitfreigabe · 1 Sperre · 1 Zugang pausiert · nächstes Ende in 1[45] Min\./);
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-running-pause]')).toHaveCount(0);
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-running-pause]')).toHaveCount(2);
    await page.reload();
    await expect(page.getByTestId('running-summary')).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('running-summary').click();
    await page.reload();
    await expect(page.getByTestId('running-summary')).toHaveAttribute('aria-expanded', 'false');
  });

  test('ohne localStorage (wirft) funktioniert es trotzdem', async ({ request, page }) => {
    const ctx = await setup(request, 'run178s');
    await grantAllow(request, ctx);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
    });
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const head = page.getByTestId('running-summary');
    await expect(head).toHaveText(/^Läuft gerade: 1 Zeitfreigabe · nächstes Ende in/);
    await head.click();
    await expect(page.locator('[data-running-pause]')).toHaveCount(1);
  });
});

test.describe('TC-179 Liste', () => {
  test('Reihenfolge, Texte, Beenden / Aufheben / Fortsetzen; danach verschwindet der Block', async ({ request, page }) => {
    const ctx = await full(request, 'run179');
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await page.getByTestId('running-summary').click();
    const rows = page.locator('.running-row');
    await expect(rows).toHaveCount(3);
    const [allow, deny] = snoozes(ctx);
    await expect(rows.nth(0)).toHaveAttribute('data-running-pause', String(allow.id));
    await expect(rows.nth(0)).toContainText('Zeitfreigabe');
    await expect(rows.nth(0)).toContainText('add_item');
    await expect(rows.nth(0)).toContainText(new RegExp(`${ctx.A.name} · noch 1[45] Min\\.`));
    await expect(rows.nth(0)).toContainText('Wofür: Einkauf');
    await expect(rows.nth(1)).toHaveAttribute('data-running-pause', String(deny.id));
    await expect(rows.nth(1)).toContainText('Sperre');
    await expect(rows.nth(1)).toContainText(`ganz ${ctx.up.name}`);
    await expect(rows.nth(1)).toContainText(/noch (59|60) Min\.|noch 1 Std\./);
    await expect(rows.nth(2)).toHaveAttribute('data-running-client', String(ctx.C.id));
    await expect(rows.nth(2)).toContainText('Zugang pausiert');
    await expect(rows.nth(2)).toContainText(/seit \d\d:\d\d/);

    await rows.nth(0).getByRole('button', { name: 'Beenden' }).click();
    await expect(page.getByText('Zeitfreigabe beendet')).toBeVisible();
    await expect(page.locator('[data-running-pause]')).toHaveCount(1);
    expect(snoozes(ctx).map((s: any) => s.id)).toEqual([deny.id]);
    await page.locator(`[data-running-pause="${deny.id}"]`).getByRole('button', { name: 'Aufheben' }).click();
    await expect(page.getByText('Sperre aufgehoben')).toBeVisible();
    expect(snoozes(ctx)).toEqual([]);
    await page.locator(`[data-running-client="${ctx.C.id}"]`).getByRole('button', { name: 'Fortsetzen' }).click();
    await expect(page.getByText(`„${ctx.C.name}“ fortgesetzt`)).toBeVisible();
    expect(dbAll('select pausedAt from McpClient where id = ?', ctx.C.id)[0].pausedAt).toBeNull();
    await expect(page.getByTestId('running')).toHaveCount(0);
  });

  test('„bis Mitternacht“ und „alle Lesetools von …“; Vorschlag-Zweck markiert', async ({ request, page }) => {
    const ctx = await setup(request, 'run179m');
    const c = startCall(request, ctx.up.slug, ctx.A.token, 'list_items', {});
    const p = await heldOf(request, ctx, 'list_items');
    expect((await decide(request, p.id, { decision: 'approve', snoozeUntilMidnight: true, snoozeScope: 'readonly', purpose: 'Stub-Zweck Art', purposeSource: 'suggested' }, ctx.user)).status()).toBe(200);
    await c;
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await page.getByTestId('running-summary').click();
    const row = page.locator('[data-running-pause]');
    await expect(row).toContainText(`alle Lesetools von ${ctx.up.name}`);
    // In the last hour before midnight it counts down instead.
    await expect(row).toContainText(/bis Mitternacht|noch \d+ Min\./);
    await expect(row).toContainText('Wofür: Stub-Zweck Art (Vorschlag)');
  });
});

test.describe('TC-180 Alle beenden', () => {
  test('Bestätigung mit Zahlen; Abbrechen ändert nichts; bestätigt: alle Zeitfreigaben und Sperren weg, pausierte Zugänge bleiben', async ({ request, page }) => {
    const ctx = await full(request, 'run180');
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await page.getByTestId('running-summary').click();
    await page.getByRole('button', { name: 'Alle beenden' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('1 Zeitfreigabe beenden und 1 Sperre aufheben?');
    await expect(dialog).toContainText('Pausierte Zugänge bleiben pausiert');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toHaveCount(0);
    expect(snoozes(ctx)).toHaveLength(2);
    await page.getByRole('button', { name: 'Alle beenden' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Alle beenden' }).click();
    await expect(page.getByText('2 Einträge beendet')).toBeVisible();
    expect(snoozes(ctx)).toEqual([]);
    expect(dbAll('select pausedAt from McpClient where id = ?', ctx.C.id)[0].pausedAt).not.toBeNull();
    await expect(page.getByTestId('running-summary').locator('.running-text')).toHaveText('Läuft gerade: 1 Zugang pausiert');
    await expect(page.locator('[data-running-client]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Alle beenden' })).toHaveCount(0);
  });
});

test.describe('TC-181 Live und Ablauf', () => {
  test('Stream `running`: bei Anlegen, Beenden, Alle beenden, KI-Abbruch, Pausieren; nur für den eigenen Nutzer', async ({ request }) => {
    const ctx = await setup(request, 'run181');
    const other = await setup(request, 'run181x');
    const mine = await openStream(ctx.user);
    const theirs = await openStream(other.user);
    const pings = () => mine.events.filter((e) => e.event === 'running').length;
    try {
      let n = 0;
      const step = async (label: string, fn: () => Promise<unknown>) => {
        await fn();
        await expect.poll(pings, { message: label, timeout: 4000 }).toBeGreaterThan(n);
        n = pings();
      };
      await step('Zeitfreigabe angelegt', () => grantAllow(request, ctx));
      const id = snoozes(ctx)[0].id;
      await step('einzeln beendet', () => request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${id}`, { headers: ctx.user }));
      await step('Sperre angelegt', () => setDeny(request, ctx));
      await step('alle beendet', () => request.delete('/api/running/pauses', { headers: ctx.user }));
      await step('Zugang pausiert', () => pauseClient(request, ctx, ctx.B.id, true));
      await step('Zugang fortgesetzt', () => pauseClient(request, ctx, ctx.B.id, false));
      // ADR-0029: the AI check ends the Zeitfreigabe on a mismatch.
      await step('erneut angelegt', () => grantAllow(request, ctx));
      await step('KI-Abbruch', async () => {
        const c = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'B', __check: 'wechsel:0.9' });
        await expect.poll(() => snoozes(ctx).length, { timeout: 6000 }).toBe(0);
        const p = await heldOf(request, ctx, 'add_item');
        await decide(request, p.id, { decision: 'deny' }, ctx.user);
        await c;
      });
      expect(theirs.events.filter((e) => e.event === 'running')).toEqual([]);
      for (const e of mine.events.filter((e) => e.event === 'running')) expect(e.data).toEqual({});
    } finally {
      await mine.close();
      await theirs.close();
    }
  });

  test('Seite: neuer Eintrag erscheint ohne Neuladen, beendeter verschwindet; abgelaufener verschwindet von selbst', async ({ request, page }) => {
    const ctx = await setup(request, 'run181u');
    await page.clock.install();
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await expect(page.getByText('Keine offenen Freigaben.')).toBeVisible();
    await grantAllow(request, ctx);
    await expect(page.getByTestId('running-summary')).toHaveText(/1 Zeitfreigabe/, { timeout: 5000 });
    const id = snoozes(ctx)[0].id;
    await request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${id}`, { headers: ctx.user });
    await expect(page.getByTestId('running')).toHaveCount(0, { timeout: 5000 });
    // Expiry: a pause ending in 20 s vanishes once the page clock passes it.
    await grantAllow(request, ctx);
    await expect(page.getByTestId('running-summary')).toHaveText(/1 Zeitfreigabe/, { timeout: 5000 });
    dbRun('update Snooze set until = ? where upstreamId = ?', new Date(Date.now() + 20_000).toISOString().replace('Z', '+00:00'), ctx.up.id);
    await page.reload();
    await expect(page.getByTestId('running-summary')).toHaveText(/nächstes Ende in < 1 Min\./);
    await page.clock.fastForward('00:45');
    await expect(page.getByTestId('running')).toHaveCount(0);
  });
});

test.describe('TC-182 Sicherheit (fail closed)', () => {
  test('nur eigene Einträge; Alle beenden trifft nur den Aufrufer; fremde ids → 404; keine Argumente/Geheimnisse; ohne Remote-User 401 (Mutationsziel)', async ({ request }) => {
    const a = await full(request, 'run182a');
    const b = await full(request, 'run182b');
    const ra = await running(request, a.user);
    const rb = await running(request, b.user);
    expect(ra.pauses.map((p: any) => p.upstream.id)).toEqual([a.up.id, a.up.id]);
    expect(ra.paused.map((c: any) => c.id)).toEqual([a.C.id]);
    expect(JSON.stringify(ra)).not.toContain(b.up.name);
    expect(rb.pauses.every((p: any) => p.upstream.id === b.up.id)).toBe(true);
    // Payload: names, scope, times, purpose only.
    expect(Object.keys(ra.pauses[0]).sort()).toEqual(['client', 'createdAt', 'effect', 'id', 'purpose', 'purposeSource', 'scope', 'toolName', 'until', 'upstream']);
    expect(Object.keys(ra.pauses[0].upstream).sort()).toEqual(['id', 'name']);
    expect(Object.keys(ra.pauses[0].client).sort()).toEqual(['id', 'name']);
    expect(Object.keys(ra.paused[0]).sort()).toEqual(['id', 'name', 'pausedAt']);
    expect(JSON.stringify(ra)).not.toMatch(/token|secret|arguments|anchor/i);
    // B ends "all": only B's.
    const before = snoozes(a).length;
    const res = await request.delete('/api/running/pauses', { headers: b.user });
    expect(res.status()).toBe(200);
    expect((await res.json()).ended).toBe(2);
    expect(snoozes(b)).toEqual([]);
    expect(snoozes(a)).toHaveLength(before);
    // B cannot end A's entries one by one either.
    const aId = snoozes(a)[0].id;
    expect((await request.delete(`/api/upstreams/${a.up.id}/snoozes/${aId}`, { headers: b.user })).status()).toBe(404);
    expect((await pauseClient(request, b, a.C.id, false)).status()).toBe(404);
    expect(snoozes(a)).toHaveLength(before);
    expect(dbAll('select pausedAt from McpClient where id = ?', a.C.id)[0].pausedAt).not.toBeNull();
    // /api only, with Remote-User.
    expect((await request.get('/api/running')).status()).toBe(401);
    expect((await request.delete('/api/running/pauses')).status()).toBe(401);
    expect(snoozes(a)).toHaveLength(before);
  });
});

test.describe('TC-183 UI 390×844', () => {
  test('Zeile eingeklappt höchstens 2 Zeilen, Knöpfe ≥ 44 px, kein horizontales Scrollen, Karten direkt darunter', async ({ request, page }) => {
    const ctx = await full(request, 'run183');
    await page.setExtraHTTPHeaders(ctx.user);
    await page.evaluate(() => 0);
    const held = startCall(request, ctx.up.slug, ctx.A.token, 'list_items', { item: 'Wartet' });
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('xitl.running.open'));
    await page.reload();
    const head = page.getByTestId('running-summary');
    await expect(head).toBeVisible();
    const card = page.locator('article.approval').first();
    await expect(card).toBeVisible();
    const hb = (await head.boundingBox())!;
    expect(hb.height).toBeLessThanOrEqual(64);
    expect(hb.x + hb.width).toBeLessThanOrEqual(390);
    const cb = (await card.boundingBox())!;
    expect(cb.y - (hb.y + hb.height)).toBeLessThan(40);
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc183-zu.png') });
    await head.click();
    for (const b of await page.locator('.running-row .btn, .running-all').all()) {
      const bb = (await b.boundingBox())!;
      expect(bb.height).toBeGreaterThanOrEqual(44);
      expect(bb.x + bb.width).toBeLessThanOrEqual(390);
    }
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc183-offen.png') });
    const p = (await pendingList(request, ctx.user)).find((x) => x.upstream.id === ctx.up.id)!;
    await decide(request, p.id, { decision: 'deny' }, ctx.user);
    await held;
  });
});
