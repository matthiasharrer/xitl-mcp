// AI purpose suggestions ("Wofür?" chips) for Zeitfreigaben (Matthias
// 2026-10-07, idea "Purpose suggestion from Qwen"): TC-172…177. The intent
// stub (INTENT_LLM_STUB) answers "zweck_eng": "Stub-Zweck eng", "zweck_art":
// "Stub-Zweck Art" unless the call's `__zweck` says: keine | nur-art | lang |
// boese. The fake Clef answers by the new call's `__check` (pause-check).
// Units: apps/api/src/intent/{parse,prompt,queue}.test.ts,
// apps/web/src/lib/purpose.test.ts, apps/api/src/approval/message.test.ts.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, listTools } from '../support/upstream.js';
import { decide, lastAudit, openStream, pendingList, startCall } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Vorschlag ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Vorschlag ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const c = await runOAuthFlow(request, uniq(`${prefix} A`), user);
  return { user, up, token: c.accessToken };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** The next held call of the context (not in `known`), once its intent is DONE
 * (or `done: false`: as soon as it is held). */
async function held(request: APIRequestContext, ctx: Ctx, known: string[] = [], done = true) {
  let found: any;
  await expect
    .poll(
      async () => {
        found = (await pendingList(request, ctx.user)).find((p) => p.upstream.id === ctx.up.id && !known.includes(p.id));
        return !!found && (!done || (found as any).intentStatus === 'DONE');
      },
      { timeout: 8000, intervals: [50, 100, 200] },
    )
    .toBe(true);
  return found;
}
const snoozes = (ctx: Ctx) => dbAll('select * from Snooze where upstreamId = ? order by id', ctx.up.id);
const auditOf = (approvalId: string) => dbAll('select * from AuditEntry where approvalId = ?', approvalId)[0];
const ZWECK_ENG = 'Stub-Zweck eng';
const ZWECK_ART = 'Stub-Zweck Art';

test.describe('TC-172 Vorschläge kommen mit der Zusammenfassung', () => {
  test('gespeichert, in GET pending / Detail / SSE intent; nicht in der Verlauf-Liste; fremder Nutzer sieht nichts', async ({ request }) => {
    const ctx = await setup(request, 'ps172');
    const stream = await openStream(ctx.user);
    try {
      const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'Milch' });
      const p = await held(request, ctx);
      expect(p).toMatchObject({ intentStatus: 'DONE', intentPurposeNarrow: ZWECK_ENG, intentPurposeKind: ZWECK_ART });
      const detail = await (await request.get(`/api/approvals/${p.id}`, { headers: ctx.user })).json();
      expect(detail).toMatchObject({ state: 'pending', intentPurposeNarrow: ZWECK_ENG, intentPurposeKind: ZWECK_ART });
      const row = auditOf(p.id);
      expect(row).toMatchObject({ intentStatus: 'DONE', intentPurposeNarrow: ZWECK_ENG, intentPurposeKind: ZWECK_ART });
      await expect
        .poll(() => stream.events.find((e) => e.event === 'intent' && e.data.id === p.id)?.data, { timeout: 4000 })
        .toMatchObject({ intentStatus: 'DONE', intentPurposeNarrow: ZWECK_ENG, intentPurposeKind: ZWECK_ART });
      // The Verlauf list row does not carry them (list API and `history` event).
      const list = await (await request.get('/api/audit', { headers: ctx.user })).json();
      const entry = list.entries.find((e: any) => e.id === row.id);
      expect(entry).toBeTruthy();
      expect(Object.keys(entry).filter((k) => k.startsWith('intentPurpose'))).toEqual([]);
      for (const ev of stream.events.filter((e) => e.event === 'history')) expect(JSON.stringify(ev.data)).not.toContain('Stub-Zweck');
      // S5: another user sees neither the call nor its suggestions.
      const other = freshUser('ps172x');
      expect((await request.get(`/api/approvals/${p.id}`, { headers: other })).status()).toBe(404);
      expect(JSON.stringify(await pendingList(request, other))).not.toContain('Stub-Zweck');
      // The suggestions decided nothing: the call is still held.
      expect((await pendingList(request, ctx.user)).map((x) => x.id)).toContain(p.id);
      await decide(request, p.id, { decision: 'deny' }, ctx.user);
      await call;
      // Resolved detail still shows what was offered.
      const resolved = await (await request.get(`/api/approvals/${p.id}`, { headers: ctx.user })).json();
      expect(resolved).toMatchObject({ state: 'resolved', intentPurposeNarrow: ZWECK_ENG, intentPurposeKind: ZWECK_ART });
    } finally {
      await stream.close();
    }
  });

  test('gekappt (≤ 120), bereinigt, fehlend → null; die Zusammenfassung bleibt', async ({ request }) => {
    const ctx = await setup(request, 'ps172c');
    const known: string[] = [];
    const cases: [string, unknown, unknown][] = [
      ['keine', null, null],
      ['nur-art', null, ZWECK_ART],
      ['boese', 'Aufgabe 21 archivieren', 'Aufgaben archivieren'],
    ];
    for (const [zweck, eng, art] of cases) {
      const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: zweck, __zweck: zweck });
      const p = await held(request, ctx, known);
      known.push(p.id);
      expect(p, zweck).toMatchObject({ intentStatus: 'DONE', intentSummary: 'Stub: add_item', intentPurposeNarrow: eng, intentPurposeKind: art });
      await decide(request, p.id, { decision: 'deny' }, ctx.user);
      await call;
    }
    const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'lang', __zweck: 'lang' });
    const p = await held(request, ctx, known);
    expect(p.intentPurposeNarrow.length).toBe(120);
    expect(p.intentPurposeNarrow.endsWith('…')).toBe(true);
    expect(p.intentPurposeKind.length).toBeLessThanOrEqual(120);
    const row = auditOf(p.id);
    expect(row.intentPurposeNarrow).toBe(p.intentPurposeNarrow);
    await decide(request, p.id, { decision: 'deny' }, ctx.user);
    await call;
  });

  test('Karte: erst ohne Chips (Feld nutzbar), dann live „Nur dies“ / „Diese Art“ mit „KI-Vorschlag“; nur-art → ein Chip; keine → keiner', async ({ request, page }) => {
    const ctx = await setup(request, 'ps172u');
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'Eier', __stub: 'slow' });
    const p = await held(request, ctx, [], false);
    const card = page.locator(`[data-approval="${p.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByText('Zusammenfassung wird erstellt…')).toBeVisible();
    await expect(card.getByTestId('purpose-suggest')).toHaveCount(0);
    await card.getByLabel('Wofür? (optional').fill('schon getippt');
    // Live via SSE `intent`.
    await expect(card.getByTestId('purpose-suggest')).toBeVisible({ timeout: 5000 });
    await expect(card.getByTestId('purpose-suggest')).toContainText('KI-Vorschlag');
    await expect(card.getByRole('button', { name: `Nur dies: ${ZWECK_ENG}` })).toBeVisible();
    await expect(card.getByRole('button', { name: `Diese Art: ${ZWECK_ART}` })).toBeVisible();
    // Arriving chips never overwrite what the human typed.
    await expect(card.getByLabel('Wofür? (optional')).toHaveValue('schon getippt');
    await card.getByRole('button', { name: 'Ablehnen', exact: true }).click();
    await call;

    for (const [zweck, n] of [['nur-art', 1], ['keine', 0]] as const) {
      const c2 = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: zweck, __zweck: zweck });
      const p2 = await held(request, ctx, [p.id]);
      await page.goto('/');
      const card2 = page.locator(`[data-approval="${p2.id}"]`);
      await expect(card2.getByLabel('KI-Zusammenfassung')).toBeVisible();
      await expect(card2.locator('.suggest-chip')).toHaveCount(n);
      if (n === 1) await expect(card2.getByRole('button', { name: `Diese Art: ${ZWECK_ART}` })).toBeVisible();
      await decide(request, p2.id, { decision: 'deny' }, ctx.user);
      await c2;
    }
  });
});

test.describe('TC-173 Chip wählen', () => {
  test('Tipp füllt das Feld; Zeitfreigabe speichert „suggested“; Prüfung, Verlauf und Regeln zeigen „(Vorschlag)“', async ({ request, page }) => {
    const ctx = await setup(request, 'ps173');
    await page.setExtraHTTPHeaders(ctx.user);
    const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'Anker' });
    const p = await held(request, ctx);
    await page.goto('/');
    const card = page.locator(`[data-approval="${p.id}"]`);
    const field = card.getByLabel('Wofür? (optional');
    await card.getByRole('button', { name: `Diese Art: ${ZWECK_ART}` }).click();
    await expect(field).toHaveValue(ZWECK_ART);
    await expect(card.getByTestId('purpose-suggested-note')).toBeVisible();
    await card.getByRole('button', { name: 'Erlauben · 15 Min. nicht mehr fragen' }).click();
    await expect(page.getByText(/Erlaubt, 15 Minuten ohne Nachfrage/)).toBeVisible();
    await call;
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ effect: 'ALLOW', purpose: ZWECK_ART, purposeSource: 'suggested' })]);

    // Same ADR-0029 purpose path as a typed one; the audit copies the source.
    expect((await callTool(request, ctx.up.slug, ctx.token, 'add_item', { item: 'B', __check: 'gleich:0.95' })).isError).toBeFalsy();
    const a = lastAudit(ctx.up.id);
    expect(a).toMatchObject({ decisionPath: 'snooze+ki', pausePurpose: ZWECK_ART, pausePurposeSource: 'suggested' });
    const detail = await (await request.get(`/api/audit/${a.id}`, { headers: ctx.user })).json();
    expect(detail).toMatchObject({ pausePurpose: ZWECK_ART, pausePurposeSource: 'suggested' });
    await page.goto(`/#/verlauf/${a.id}`);
    await expect(page.getByTestId('pause-purpose')).toHaveText(`${ZWECK_ART} (Vorschlag)`);
    await page.goto(`/#/regeln/${ctx.up.id}`);
    await expect(page.getByTestId('pause-purpose')).toHaveText(`Wofür: ${ZWECK_ART} (Vorschlag)`);
    const list = await (await request.get(`/api/upstreams/${ctx.up.id}/snoozes`, { headers: ctx.user })).json();
    expect(list[0]).toMatchObject({ purpose: ZWECK_ART, purposeSource: 'suggested' });
  });

  test('Tipp, dann bearbeitet → „typed“, kein „(Vorschlag)“', async ({ request, page }) => {
    const ctx = await setup(request, 'ps173e');
    await page.setExtraHTTPHeaders(ctx.user);
    const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'Anker' });
    const p = await held(request, ctx);
    await page.goto('/');
    const card = page.locator(`[data-approval="${p.id}"]`);
    const field = card.getByLabel('Wofür? (optional');
    await card.getByRole('button', { name: `Nur dies: ${ZWECK_ENG}` }).click();
    await expect(field).toHaveValue(ZWECK_ENG);
    await field.fill(`${ZWECK_ENG} und Brot`);
    await expect(card.getByTestId('purpose-suggested-note')).toHaveCount(0);
    await card.getByRole('button', { name: 'Erlauben · 15 Min. nicht mehr fragen' }).click();
    await expect(page.getByText(/Erlaubt, 15 Minuten ohne Nachfrage/)).toBeVisible();
    await call;
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ purpose: `${ZWECK_ENG} und Brot`, purposeSource: 'typed' })]);
    await page.goto(`/#/regeln/${ctx.up.id}`);
    await expect(page.getByTestId('pause-purpose')).toHaveText(`Wofür: ${ZWECK_ENG} und Brot`);
  });

  test('Server: Herkunft nur mit Zweck; andere Werte → 400; Zweck wie bisher geprüft; ohne Herkunft = typed', async ({ request }) => {
    const ctx = await setup(request, 'ps173a');
    const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'x' });
    const p = await held(request, ctx, [], false);
    for (const data of [
      { decision: 'approve', snoozeMinutes: 15, purposeSource: 'suggested' },
      { decision: 'approve', snoozeMinutes: 15, purpose: '   ', purposeSource: 'suggested' },
      { decision: 'approve', snoozeMinutes: 15, purpose: 'x', purposeSource: 'ki' },
      { decision: 'approve', snoozeMinutes: 15, purpose: 'x', purposeSource: true },
      { decision: 'approve', snoozeMinutes: 15, purpose: 'x'.repeat(201), purposeSource: 'suggested' },
      { decision: 'approve', snoozeMinutes: 15, purpose: 'a\nb', purposeSource: 'suggested' },
      { decision: 'approve', purpose: 'ohne Dauer', purposeSource: 'suggested' },
    ]) {
      expect((await decide(request, p.id, data, ctx.user)).status(), JSON.stringify(data)).toBe(400);
    }
    expect(snoozes(ctx)).toEqual([]);
    const ok = await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, purpose: 'Einkauf' }, ctx.user);
    expect(ok.status()).toBe(200);
    await call;
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ purpose: 'Einkauf', purposeSource: 'typed' })]);
  });
});

test.describe('TC-174 Nie für Sperren', () => {
  test('Server: Ablehnen mit Herkunft „suggested“ → 400, keine Sperre (Mutationsziel)', async ({ request }) => {
    const ctx = await setup(request, 'ps174');
    const call = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'x' });
    const p = await held(request, ctx, [], false);
    for (const data of [
      { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'tool', purpose: ZWECK_ART, purposeSource: 'suggested' },
      { decision: 'deny', snoozeUntilMidnight: true, snoozeScope: 'upstream', purpose: ZWECK_ENG, purposeSource: 'suggested' },
    ]) {
      expect((await decide(request, p.id, data, ctx.user)).status(), JSON.stringify(data)).toBe(400);
    }
    expect(snoozes(ctx)).toEqual([]);
    expect((await pendingList(request, ctx.user)).map((x) => x.id)).toContain(p.id);
    // A typed purpose on a Sperre as before (explicit "typed" accepted too).
    const ok = await decide(request, p.id, { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'tool', purpose: 'keine Einkäufe', purposeSource: 'typed' }, ctx.user);
    expect(ok.status()).toBe(200);
    await call;
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ effect: 'DENY', purpose: 'keine Einkäufe', purposeSource: 'typed' })]);
  });

  test('Karte: unveränderter Chip-Text + Sperre → Sperre OHNE Zweck; getippter Text gilt für die Sperre', async ({ request, page }) => {
    const ctx = await setup(request, 'ps174u');
    await page.setExtraHTTPHeaders(ctx.user);
    const c1 = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'A' });
    const p1 = await held(request, ctx);
    await page.goto('/');
    const card = page.locator(`[data-approval="${p1.id}"]`);
    await card.getByRole('button', { name: `Diese Art: ${ZWECK_ART}` }).click();
    await expect(card.getByLabel('Wofür? (optional')).toHaveValue(ZWECK_ART);
    await card.getByRole('button', { name: 'Ablehnen · 15 Min. sperren' }).click();
    await expect(page.getByText(/Abgelehnt, 15 Minuten gesperrt.*ohne KI-Vorschlag als Zweck/)).toBeVisible();
    await c1;
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ effect: 'DENY', purpose: null, purposeSource: null })]);

    // Typed after the tap: the Sperre takes it.
    const ctx2 = await setup(request, 'ps174t');
    await page.setExtraHTTPHeaders(ctx2.user);
    const c2 = startCall(request, ctx2.up.slug, ctx2.token, 'add_item', { item: 'B' });
    const p2 = await held(request, ctx2);
    await page.goto('/');
    const card2 = page.locator(`[data-approval="${p2.id}"]`);
    await card2.getByRole('button', { name: `Nur dies: ${ZWECK_ENG}` }).click();
    await card2.getByLabel('Wofür? (optional').fill('keine Einkäufe mehr');
    await card2.getByRole('button', { name: 'Ablehnen · 15 Min. sperren' }).click();
    await expect(page.getByText(/Abgelehnt, 15 Minuten gesperrt/)).toBeVisible();
    await c2;
    expect(snoozes(ctx2)).toEqual([expect.objectContaining({ effect: 'DENY', purpose: 'keine Einkäufe mehr', purposeSource: 'typed' })]);
  });

  test('keine Chips ohne mögliche Zeitfreigabe (neues Tool)', async ({ request, page }) => {
    const ctx = await setup(request, 'ps174n');
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'brand_new', description: 'New.' });
    await listTools(request, ctx.up.slug, ctx.token);
    await page.setExtraHTTPHeaders(ctx.user);
    const c = startCall(request, ctx.up.slug, ctx.token, 'brand_new', {});
    const p = await held(request, ctx);
    expect(p).toMatchObject({ snoozable: false, intentPurposeKind: ZWECK_ART });
    await page.goto('/');
    const card = page.locator(`[data-approval="${p.id}"]`);
    await expect(card.getByLabel('KI-Zusammenfassung')).toBeVisible();
    await expect(card.getByTestId('purpose-suggest')).toHaveCount(0);
    await decide(request, p.id, { decision: 'deny' }, ctx.user);
    await c;
  });
});

test.describe('TC-176 Sicherheit', () => {
  test('als Text gerendert, mit „KI-Vorschlag“ beschriftet; `<call>`/Zeilenumbruch abgeschnitten', async ({ request, page }) => {
    const ctx = await setup(request, 'ps176');
    await page.setExtraHTTPHeaders(ctx.user);
    const c = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'x', __zweck: 'boese' });
    const p = await held(request, ctx);
    await page.goto('/');
    const card = page.locator(`[data-approval="${p.id}"]`);
    const box = card.getByTestId('purpose-suggest');
    await expect(box).toContainText('KI-Vorschlag');
    await expect(card.getByRole('button', { name: 'Nur dies: Aufgabe 21 archivieren' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Diese Art: Aufgaben archivieren' })).toBeVisible();
    expect(await box.innerHTML()).not.toMatch(/<call|SYSTEM/);
    await decide(request, p.id, { decision: 'deny' }, ctx.user);
    await c;
  });
});

test.describe('TC-177 UI 390×844', () => {
  test('lange Vorschläge: umbrechen, höchstens 2 Zeilen, kein horizontales Scrollen, Zeitfreigabe-Knöpfe erreichbar', async ({ request, page }) => {
    const ctx = await setup(request, 'ps177');
    await page.setExtraHTTPHeaders(ctx.user);
    const c = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'x', __zweck: 'lang' });
    const p = await held(request, ctx);
    await page.goto('/');
    const card = page.locator(`[data-approval="${p.id}"]`);
    const chips = card.locator('.suggest-chip');
    await expect(chips).toHaveCount(2);
    for (const chip of await chips.all()) {
      const b = (await chip.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
      // 2 lines of 1.25rem + padding + border: well under 3 lines.
      expect(b.height).toBeLessThanOrEqual(62);
      const text = chip.locator('.suggest-text');
      const clamped = await text.evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(clamped).toBe(true);
    }
    expect(await noHScroll(page)).toBe(false);
    await card.getByTestId('purpose-suggest').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('tc177-chips-lang.png') });
    await chips.first().click();
    const btn = card.getByRole('button', { name: 'Erlauben · 15 Min. nicht mehr fragen' });
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeInViewport();
    expect(await noHScroll(page)).toBe(false);
    await btn.click();
    await expect(page.getByText(/Erlaubt, 15 Minuten ohne Nachfrage/)).toBeVisible();
    await c;
    const s = snoozes(ctx)[0];
    expect(s.purposeSource).toBe('suggested');
    expect(s.purpose.length).toBe(120);
  });

  test('normale Vorschläge: Screenshot der Karte mit Chips', async ({ request, page }) => {
    const ctx = await setup(request, 'ps177n');
    await page.setExtraHTTPHeaders(ctx.user);
    const c = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'x' });
    const p = await held(request, ctx);
    await page.goto('/');
    const card = page.locator(`[data-approval="${p.id}"]`);
    await card.getByRole('button', { name: `Nur dies: ${ZWECK_ENG}` }).click();
    await card.getByTestId('purpose-suggest').scrollIntoViewIfNeeded();
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc177-chips.png') });
    await decide(request, p.id, { decision: 'deny' }, ctx.user);
    await c;
  });
});
