// Live Verlauf (ADR-0028): TC-133…135 (TC-136 and the emitter are unit tests:
// apps/web/src/lib/historyLive.test.ts, apps/api/src/lib/auditEvents.test.ts).
// Verlauf rides on the existing /api/approvals/stream: a `history` event per
// audit write of the user's own calls, in exactly the list row's shape.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { askUpstream, decide, openStream, startCall, waitPending } from '../support/approval.js';
import { callTool } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Live ${prefix}`,
});

const auditList = async (request: APIRequestContext, user: Identity) =>
  ((await (await request.get('/api/audit', { headers: user })).json()) as { entries: Record<string, any>[] }).entries;

type Ev = { event: string; data: any };
const historyOf = (events: Ev[], id?: number) => events.filter((e) => e.event === 'history' && (id === undefined || e.data.id === id));

test.describe('API', () => {
  test('TC-133 history-Events: je Schreibvorgang der eigenen Aufrufe, exakt die Listenzeile, in Reihenfolge; Zusammenfassung kommt nach', async ({ request }) => {
    const user = freshUser('hl-api');
    const allow = await askUpstream(request, 'hlallow', { defaultPolicy: 'ALLOW' }, user);
    const ask = await askUpstream(request, 'hlask', {}, user);
    const stream = await openStream(user);
    try {
      expect(stream.events.length === 0 || stream.events[0]!.event === 'snapshot').toBe(true);

      // auto-allowed
      expect((await callTool(request, allow.up.slug, allow.token, 'list_items')).isError).toBeFalsy();
      // held, then approved
      const held = startCall(request, ask.up.slug, ask.token, 'add_item', { item: 'Milch' });
      const p = await waitPending(request, ask.up.id, 'add_item', user);
      await expect.poll(() => historyOf(stream.events).filter((e) => e.data.outcome === 'PENDING' && e.data.upstream.id === ask.up.id).length).toBeGreaterThan(0);
      expect((await decide(request, p.id, { decision: 'approve' }, user)).status()).toBe(200);
      await held;
      // held, then denied
      const held2 = startCall(request, ask.up.slug, ask.token, 'add_item', { item: 'Brot' });
      const p2 = await waitPending(request, ask.up.id, 'add_item', user);
      expect((await decide(request, p2.id, { decision: 'deny' }, user)).status()).toBe(200);
      await held2;

      const entries = await auditList(request, user);
      expect(entries).toHaveLength(3);
      // the stub summary arrives after the outcome: wait for DONE on every row
      await expect.poll(async () => (await auditList(request, user)).every((e) => e.intentStatus === 'DONE')).toBe(true);
      const final = await auditList(request, user);
      for (const row of final) {
        await expect.poll(() => historyOf(stream.events, row.id).at(-1)?.data, { timeout: 5000 }).toEqual(row);
        const seq = historyOf(stream.events, row.id).map((e) => e.data);
        // created (PENDING) first, the outcome next, the summary last
        expect(seq[0].outcome).toBe('PENDING');
        expect(seq.at(-1).outcome).not.toBe('PENDING');
        expect(seq.at(-1).intentStatus).toBe('DONE');
        expect(Object.keys(seq.at(-1)).sort()).toEqual(Object.keys(row).sort());
      }
      expect(final.map((e) => e.outcome).sort()).toEqual(['DENIED', 'FORWARDED', 'FORWARDED']);
      // the held-then-approved row passed through PENDING and a decided state
      const heldRow = final.find((e) => e.upstream.id === ask.up.id && e.outcome === 'FORWARDED')!;
      expect(historyOf(stream.events, heldRow.id).map((e) => e.data.outcome)).toContain('PENDING');
    } finally {
      await stream.close();
    }
  });

  test('TC-134 Scheitert geschlossen: Aufrufe von B erzeugen auf As Stream nichts (kein history, keine Namen); B bekommt sie auf seinem', async ({ request }) => {
    const a = freshUser('hl-a');
    const b = freshUser('hl-b');
    const ua = await askUpstream(request, 'hla', { defaultPolicy: 'ALLOW' }, a);
    const ub = await askUpstream(request, 'hlb', {}, b);
    const ubAllow = await askUpstream(request, 'hlb2', { defaultPolicy: 'ALLOW' }, b);
    const streamA = await openStream(a);
    const streamB = await openStream(b);
    try {
      expect((await callTool(request, ubAllow.up.slug, ubAllow.token, 'list_items')).isError).toBeFalsy();
      const held = startCall(request, ub.up.slug, ub.token, 'add_item', { item: 'GeheimB' });
      const p = await waitPending(request, ub.up.id, 'add_item', b);
      expect((await decide(request, p.id, { decision: 'approve' }, b)).status()).toBe(200);
      await held;
      // control: A's own call does arrive on A's stream
      expect((await callTool(request, ua.up.slug, ua.token, 'list_items')).isError).toBeFalsy();

      const rowsB = await auditList(request, b);
      expect(rowsB).toHaveLength(2);
      await expect.poll(() => rowsB.every((r) => historyOf(streamB.events, r.id).length > 0)).toBe(true);
      const rowsA = await auditList(request, a);
      expect(rowsA).toHaveLength(1);
      await expect.poll(() => historyOf(streamA.events, rowsA[0]!.id).length).toBeGreaterThan(0);

      await expect.poll(() => historyOf(streamB.events).some((e) => e.data.outcome === 'FORWARDED' && e.data.intentStatus === 'DONE')).toBe(true);
      // A's stream: only A's row, nothing that names B's client, upstream or call
      const idsA = new Set(rowsA.map((r) => r.id));
      expect(historyOf(streamA.events).every((e) => idsA.has(e.data.id))).toBe(true);
      const wire = JSON.stringify(streamA.events);
      for (const secret of [ub.clientName, ub.up.slug, ubAllow.up.slug, ub.up.name, 'GeheimB', p.id, ...rowsB.map((r) => `"id":${r.id},`)]) {
        expect(wire).not.toContain(secret);
      }
      expect((await auditList(request, a)).map((r) => r.id)).toEqual(rowsA.map((r) => r.id));
      // never more than the list row: no arguments / result / diagnostics on the wire
      for (const e of historyOf(streamB.events)) {
        for (const k of ['arguments', 'resultText', 'endpoint', 'policy', 'diagnostics', 'intentPrompt', 'intentAnswer', 'intentModelRisk']) {
          expect(Object.keys(e.data)).not.toContain(k);
        }
      }
    } finally {
      await streamA.close();
      await streamB.close();
    }
  });
});

test.describe('im Browser', () => {
  test('TC-135 ⚡ Verlauf live: neuer Aufruf oben, Zustandswechsel und Titel an Ort und Stelle, Detail folgt, fremde Aufrufe nie, Ältere laden bleibt heil', async ({ page, request }) => {
    const user = freshUser('hl-ui');
    const other = freshUser('hl-ui-other');
    const allow = await askUpstream(request, 'hluiallow', { defaultPolicy: 'ALLOW' }, user);
    const ask = await askUpstream(request, 'hluiask', {}, user);
    const foreign = await askUpstream(request, 'hluifor', { defaultPolicy: 'ALLOW' }, other);
    await page.context().setExtraHTTPHeaders(user);
    await page.goto('/#/verlauf');
    await expect(page.getByText('Noch keine Aufrufe.')).toBeVisible();

    // 1. a new auto-allowed call appears without reload, with its AI title
    expect((await callTool(request, allow.up.slug, allow.token, 'list_items')).isError).toBeFalsy();
    const rows = page.locator('li.history-item');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('section.history-day h3.day-label')).toHaveText('Heute');
    await expect(rows.first().getByTestId('call-title')).toBeVisible({ timeout: 6000 });
    await expect(rows.first().locator('.chip')).toHaveText('Weitergeleitet');

    // 2. a held call: row on top as "Offen", then decided in place
    const held = startCall(request, ask.up.slug, ask.token, 'add_item', { item: 'Eier' });
    const p = await waitPending(request, ask.up.id, 'add_item', user);
    await expect(rows).toHaveCount(2);
    const heldRow = rows.first();
    await expect(heldRow.locator('.chip')).toHaveText('Offen');
    const auditId = await heldRow.locator('a.history-link').getAttribute('data-audit');
    expect(rows.nth(1)).not.toHaveAttribute('data-audit', auditId!);
    // same client group? (two clients here: two groups)
    await expect(page.locator('.call-group')).toHaveCount(2);

    // 3. detail of the open row follows
    const detail = await page.context().newPage();
    await detail.goto(`/#/verlauf/${auditId}`);
    await expect(detail.locator('.audit-detail .item-head .chip')).toHaveText('Offen');

    expect((await decide(request, p.id, { decision: 'approve' }, user)).status()).toBe(200);
    await held;
    await expect(heldRow.locator('.chip')).toHaveText('Weitergeleitet');
    await expect(detail.locator('.audit-detail .item-head .chip')).toHaveText('Weitergeleitet');
    await detail.close();

    // 4. another user's calls never show up
    expect((await callTool(request, foreign.up.slug, foreign.token, 'list_items')).isError).toBeFalsy();
    await page.waitForTimeout(800);
    await expect(rows).toHaveCount(2);
    await expect(page.getByText(foreign.clientName)).toHaveCount(0);

    // 6. "Ältere laden": 50 per page, live rows neither duplicate nor lose any
    for (let i = 0; i < 50; i++) await callTool(request, allow.up.slug, allow.token, 'list_items');
    await expect(rows).toHaveCount(52, { timeout: 15_000 });
    // Now a full first page (50) with a cursor. Wait until the stream is up and
    // its snapshot-triggered refetch is done (two /api/audit loads): a call made
    // before that arrives via the refetch, which shows only the newest 50.
    let auditLoads = 0;
    const countLoads = (r: { url(): string }) => {
      if (new URL(r.url()).pathname === '/api/audit') auditLoads++;
    };
    page.on('response', countLoads);
    const stream = page.waitForResponse((r) => r.url().includes('/api/approvals/stream'));
    await page.reload();
    await stream;
    await expect.poll(() => auditLoads).toBeGreaterThanOrEqual(2);
    page.off('response', countLoads);
    await expect(rows).toHaveCount(50);
    const loadMore = page.getByRole('button', { name: 'Ältere laden' });
    await expect(loadMore).toBeVisible();
    await callTool(request, allow.up.slug, allow.token, 'list_items'); // arrives live on top of a full list
    await expect(rows).toHaveCount(51, { timeout: 8000 });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(loadMore).toBeHidden();
    const ids = await page.locator('a.history-link').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.audit));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(53);
    // no gaps: exactly the user's rows (the DOM order is by group, not by id)
    const first = (await (await request.get('/api/audit', { headers: user })).json()) as { entries: { id: number }[]; nextBefore: number | null };
    const rest = (await (await request.get(`/api/audit?before=${first.nextBefore}`, { headers: user })).json()) as { entries: { id: number }[] };
    expect(ids.map(Number).sort((x, y) => x - y)).toEqual([...first.entries, ...rest.entries].map((e) => e.id).sort((x, y) => x - y));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test('TC-135 Reconnect heilt: der Stream trägt nie ein history-Event (nur Snapshot, dann Abbruch + Wiederverbindung); Aufrufe dazwischen erscheinen trotzdem, per Refetch', async ({ page, request }) => {
    const user = freshUser('hl-heal');
    const allow = await askUpstream(request, 'hlheal', { defaultPolicy: 'ALLOW' }, user);
    await page.context().setExtraHTTPHeaders(user);
    let connects = 0;
    await page.route('**/api/approvals/stream', (route) => {
      connects++;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 300\n\nevent: snapshot\ndata: []\n\n' });
    });
    await page.goto('/#/verlauf');
    await expect(page.getByText('Noch keine Aufrufe.')).toBeVisible();
    expect((await callTool(request, allow.up.slug, allow.token, 'list_items')).isError).toBeFalsy();
    await expect(page.locator('li.history-item')).toHaveCount(1, { timeout: 8000 });
    expect((await callTool(request, allow.up.slug, allow.token, 'list_items')).isError).toBeFalsy();
    await expect(page.locator('li.history-item')).toHaveCount(2, { timeout: 8000 });
    expect(connects).toBeGreaterThan(2);
  });
});
