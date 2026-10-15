// Resume an interrupted Zeitfreigabe (ADR-0029 amendment 2026-10-15):
// TC-217…222. Same seam as pause-check.spec.ts: the fake Clef's verdict is
// driven only by the NEW call's `__check` argument. Units:
// apps/api/src/approval/snoozeSuspend.test.ts, pausecheck/gate.test.ts.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, dbRun, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeState } from '../support/upstream.js';
import { decide, pendingList, startCall, waitPending, type Pending } from '../support/approval.js';
import { firstPushes, subscribe } from '../support/push.js';
import { FAKE_CLEF } from '../support/paths.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
type Checked = Pending & {
  pauseCheck: { result: string; choice: string | null; score: number | null; interrupted?: { until: string; purpose: string | null } } | null;
};
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Fortsetzen ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function newClient(request: APIRequestContext, user: Identity, name: string) {
  const c = await runOAuthFlow(request, uniq(name), user);
  const row = dbAll('select id, name from McpClient where clientId = ?', c.clientId)[0];
  return { token: c.accessToken, id: row.id as number, name: row.name as string };
}

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`FS ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await newClient(request, user, `${prefix} A`);
  return { user, up, A };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
type Client = Ctx['A'];

async function clefLog(request: APIRequestContext, ctx: Ctx) {
  const all = (await (await request.get(`${FAKE_CLEF}/control/log`)).json()) as { body: any; blocks: any[] }[];
  return all.filter((r) => r.blocks.some((b) => b.upstream === ctx.up.name));
}
const snoozes = (ctx: Ctx) => dbAll('select * from Snooze where upstreamId = ? order by id', ctx.up.id);
const upstreamCalls = async (request: APIRequestContext, ctx: Ctx, tool: string) => (await fakeState(request, ctx.up.tenant)).calls[tool] ?? 0;
const auditOf = (approvalId: string) => dbAll('select * from AuditEntry where approvalId = ?', approvalId)[0];
const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00');

async function grant(request: APIRequestContext, ctx: Ctx, opts: { client?: Client; purpose?: string; scope?: string; tool?: string } = {}) {
  const client = opts.client ?? ctx.A;
  const tool = opts.tool ?? 'add_item';
  const held = startCall(request, ctx.up.slug, client.token, tool, { item: 'Anker' });
  const p = await waitPending(request, ctx.up.id, tool, ctx.user);
  const res = await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: opts.scope ?? 'tool', ...(opts.purpose ? { purpose: opts.purpose } : {}) }, ctx.user);
  expect(res.status(), await res.text()).toBe(200);
  expect((await held).isError).toBeFalsy();
  return auditOf(p.id);
}

async function waitHeld(request: APIRequestContext, ctx: Ctx, known: string[] = []): Promise<Checked> {
  let found: Checked | undefined;
  await expect
    .poll(async () => {
      found = ((await pendingList(request, ctx.user)) as Checked[]).find((p) => p.upstream.id === ctx.up.id && !known.includes(p.id));
      return !!found;
    }, { timeout: 6000, intervals: [50, 100, 200] })
    .toBe(true);
  return found!;
}

/** Grant + one swerving call: returns the held mismatch call and its promise. */
async function interrupt(request: APIRequestContext, ctx: Ctx, purpose = 'Einkauf eintragen') {
  const anchor = await grant(request, ctx, { purpose });
  const b = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'B', __check: 'wechsel:0.9' });
  const pb = await waitHeld(request, ctx);
  expect(pb.rulePath).toBe('snooze-ki-mismatch');
  return { anchor, b, pb };
}

test.describe('TC-217 Abweichung unterbricht (Sicherheit)', () => {
  test('Zeile bleibt mit suspendedAt; nächster Aufruf normal gefragt, Clef nicht gefragt, nie weitergeleitet; Push sagt „unterbrochen“', async ({ request }) => {
    const ctx = await setup(request, 'fs217');
    const endpoint = await subscribe(request, ctx.user);
    const { anchor, b, pb } = await interrupt(request, ctx);
    const [row] = snoozes(ctx);
    expect(row).toMatchObject({ effect: 'ALLOW', purpose: 'Einkauf eintragen', anchorAuditId: anchor.id });
    expect(row.suspendedAt).not.toBeNull();
    expect(pb.pauseCheck?.interrupted).toEqual({ until: expect.any(String), purpose: 'Einkauf eintragen' });
    // Never leaks the ids to a channel.
    expect(JSON.stringify(pb)).not.toContain('interruptedPauseIds');
    await expect.poll(() => firstPushes(endpoint).filter((e) => e.payload.id === pb.id).length).toBe(1);
    expect(firstPushes(endpoint).find((e) => e.payload.id === pb.id)!.payload.note).toBe('KI-Prüfung: weicht ab (Richtungswechsel) – Zeitfreigabe unterbrochen');

    const before = await upstreamCalls(request, ctx, 'add_item');
    const clefBefore = (await clefLog(request, ctx)).length;
    const c = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'C', __check: 'gleich:0.99' });
    const pc = await waitHeld(request, ctx, [pb.id]);
    expect(pc.rulePath).toBe('policy:upstream-default');
    expect(pc.pauseCheck).toBeNull();
    expect((await clefLog(request, ctx)).length).toBe(clefBefore);
    expect(await upstreamCalls(request, ctx, 'add_item')).toBe(before);
    // The row is untouched by the second call (until/purpose/anchor).
    expect(snoozes(ctx)).toEqual([row]);
    for (const id of [pc.id, pb.id]) expect((await decide(request, id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await c;
    await b;
  });
});

test.describe('TC-218 Erlauben & fortsetzen', () => {
  test('B weitergeleitet, Zeitfreigabe wieder aktiv mit gleichem Ende und Zweck, Anker = B; D läuft mit snooze+ki', async ({ request }) => {
    const ctx = await setup(request, 'fs218');
    const { b, pb } = await interrupt(request, ctx);
    const [before] = snoozes(ctx);
    const res = await decide(request, pb.id, { decision: 'approve', resumePause: true }, ctx.user);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'approved', resumed: 1 });
    expect((await b).isError).toBeFalsy();
    expect(auditOf(pb.id)).toMatchObject({ decisionPath: 'snooze-ki-mismatch+approved:page', outcome: 'FORWARDED' });
    const [after] = snoozes(ctx);
    expect(after).toMatchObject({ id: before.id, until: before.until, purpose: before.purpose, suspendedAt: null, anchorAuditId: auditOf(pb.id).id });

    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'D', __check: 'gleich:0.95' })).isError).toBeFalsy();
    const d = dbAll('select * from AuditEntry where upstreamId = ? order by id desc limit 1', ctx.up.id)[0];
    expect(d).toMatchObject({ decisionPath: 'snooze+ki', outcome: 'FORWARDED' });
    const log = await clefLog(request, ctx);
    expect(log[log.length - 1].blocks[0].arguments.item).toBe('B');
  });

  test('wartende Aufrufe beim Fortsetzen laufen durch die Prüfung (TC-145-Pfad)', async ({ request }) => {
    const ctx = await setup(request, 'fs218b');
    const { b, pb } = await interrupt(request, ctx);
    // Held while interrupted: a plain ASK.
    const h = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'H', __check: 'gleich:0.95' });
    const ph = await waitHeld(request, ctx, [pb.id]);
    expect(ph.rulePath).toBe('policy:upstream-default');
    expect((await decide(request, pb.id, { decision: 'approve', resumePause: true }, ctx.user)).status()).toBe(200);
    await b;
    expect((await h).isError).toBeFalsy();
    expect(auditOf(ph.id)).toMatchObject({ outcome: 'FORWARDED', decisionPath: 'policy:upstream-default+approved:pause', pauseCheckChoice: 'gleich' });
  });
});

test.describe('TC-219 Fortsetzen: Grenzen (fail closed)', () => {
  test('400 mit Dauer/Umfang/Zweck, beim Ablehnen, ohne Abweichung; fremder Nutzer 404; abgelaufen/beendet → erlaubt, resumed 0', async ({ request }) => {
    const ctx = await setup(request, 'fs219');
    const { b, pb } = await interrupt(request, ctx);
    for (const bad of [
      { decision: 'approve', resumePause: true, snoozeMinutes: 15 },
      { decision: 'approve', resumePause: true, snoozeScope: 'tool' },
      { decision: 'approve', resumePause: true, purpose: 'x' },
      { decision: 'deny', resumePause: true },
    ]) {
      expect((await decide(request, pb.id, bad, ctx.user)).status(), JSON.stringify(bad)).toBe(400);
    }
    const other = freshUser('fs219x');
    expect((await decide(request, pb.id, { decision: 'approve', resumePause: true }, other)).status()).toBe(404);
    expect(snoozes(ctx)[0].suspendedAt).not.toBeNull();

    // A plain ASK has nothing to resume.
    const c = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'C' });
    const pc = await waitHeld(request, ctx, [pb.id]);
    expect((await decide(request, pc.id, { decision: 'approve', resumePause: true }, ctx.user)).status()).toBe(400);
    expect((await decide(request, pc.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await c;

    // Expired meanwhile: B approved, nothing resumed.
    dbRun('update Snooze set until = ? where upstreamId = ?', iso(Date.now() - 1000), ctx.up.id);
    const res = await decide(request, pb.id, { decision: 'approve', resumePause: true }, ctx.user);
    expect(res.status()).toBe(200);
    expect((await res.json()).resumed).toBe(0);
    expect((await b).isError).toBeFalsy();
    expect(snoozes(ctx).every((s) => s.suspendedAt !== null)).toBe(true);
  });

  test('beendet über „Beenden“ → erlaubt, resumed 0', async ({ request }) => {
    const ctx = await setup(request, 'fs219b');
    const { b, pb } = await interrupt(request, ctx);
    const id = snoozes(ctx)[0].id;
    expect((await request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${id}`, { headers: ctx.user })).status()).toBe(200);
    const res = await decide(request, pb.id, { decision: 'approve', resumePause: true }, ctx.user);
    expect((await res.json()).resumed).toBe(0);
    await b;
    expect(snoozes(ctx)).toEqual([]);
  });
});

test.describe('TC-220 Nur erlauben / Ablehnen', () => {
  test('entscheiden nur den Aufruf; Zeitfreigabe bleibt unterbrochen; neue Zeitfreigabe = neue Zeile', async ({ request }) => {
    const ctx = await setup(request, 'fs220');
    const { b, pb } = await interrupt(request, ctx);
    expect((await decide(request, pb.id, { decision: 'approve' }, ctx.user)).status()).toBe(200);
    await b;
    expect(snoozes(ctx)[0].suspendedAt).not.toBeNull();
    const c = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'C', __check: 'gleich:0.99' });
    const pc = await waitHeld(request, ctx);
    expect(pc.rulePath).toBe('policy:upstream-default');
    expect((await decide(request, pc.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    await c;
    const rows = snoozes(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.filter((s) => s.suspendedAt === null)).toEqual([expect.objectContaining({ anchorAuditId: auditOf(pc.id).id })]);
  });
});

test.describe('TC-221 Läuft gerade: Fortsetzen', () => {
  test('API: suspendedAt im Payload; Fortsetzen → aktiv, Anker bleibt, Wartende bleiben; Sperre/aktiv/abgelaufen/fremd/unbekannt → 404; ohne Remote-User 401', async ({ request }) => {
    const ctx = await setup(request, 'fs221');
    const { anchor, b, pb } = await interrupt(request, ctx);
    const running = await (await request.get('/api/running', { headers: ctx.user })).json();
    expect(running.pauses).toEqual([expect.objectContaining({ effect: 'ALLOW', suspendedAt: expect.any(String) })]);
    const id = running.pauses[0].id as number;
    expect((await request.post(`/api/running/pauses/${id}/resume`)).status()).toBe(401);
    expect((await request.post(`/api/running/pauses/${id}/resume`, { headers: freshUser('fs221x') })).status()).toBe(404);
    expect((await request.post(`/api/running/pauses/999999/resume`, { headers: ctx.user })).status()).toBe(404);
    expect(snoozes(ctx)[0].suspendedAt).not.toBeNull();

    const res = await request.post(`/api/running/pauses/${id}/resume`, { headers: ctx.user });
    expect(res.status()).toBe(200);
    expect((await res.json()).pauses[0].suspendedAt).toBeNull();
    expect(snoozes(ctx)[0]).toMatchObject({ suspendedAt: null, anchorAuditId: anchor.id });
    // B stays held (not re-checked, not settled).
    expect(((await pendingList(request, ctx.user)) as Checked[]).map((p) => p.id)).toContain(pb.id);
    // Active now: resuming again is 404.
    expect((await request.post(`/api/running/pauses/${id}/resume`, { headers: ctx.user })).status()).toBe(404);
    expect((await decide(request, pb.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await b;

    // A Sperre is never resumable; an expired row neither.
    const s = startCall(request, ctx.up.slug, ctx.A.token, 'list_items', {});
    const ps = await waitPending(request, ctx.up.id, 'list_items', ctx.user);
    expect((await decide(request, ps.id, { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    await s;
    const sperre = snoozes(ctx).find((r) => r.effect !== 'ALLOW')!;
    dbRun('update Snooze set suspendedAt = ? where id = ?', iso(Date.now()), sperre.id);
    expect((await request.post(`/api/running/pauses/${sperre.id}/resume`, { headers: ctx.user })).status()).toBe(404);
    dbRun('update Snooze set suspendedAt = ?, until = ? where id = ?', iso(Date.now()), iso(Date.now() - 1000), id);
    expect((await request.post(`/api/running/pauses/${id}/resume`, { headers: ctx.user })).status()).toBe(404);
  });

  test('UI: Karte mit „Erlauben & fortsetzen“; Läuft gerade zeigt „unterbrochen“ + Fortsetzen; 390×844 ohne Querscrollen', async ({ request, page }) => {
    const ctx = await setup(request, 'fs221u');
    const { b, pb } = await interrupt(request, ctx);
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const card = page.locator(`[data-approval="${pb.id}"]`);
    await expect(card.getByTestId('interrupted-line')).toHaveText(/unterbrochen · noch 1[45] Min\. · „Einkauf eintragen“/);
    const resumeBtn = card.getByRole('button', { name: 'Erlauben & fortsetzen' });
    await expect(resumeBtn).toBeVisible();
    expect((await resumeBtn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(card.getByRole('button', { name: 'Nur erlauben' })).toBeVisible();
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('karte-fortsetzen.png'), fullPage: true });

    // Läuft gerade: interrupted row with Fortsetzen.
    await page.getByTestId('running-summary').click();
    const row = page.locator('[data-suspended="true"]');
    await expect(row.getByText('unterbrochen', { exact: true })).toBeVisible();
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('laeuft-gerade-unterbrochen.png'), fullPage: true });
    await row.getByRole('button', { name: /^Zeitfreigabe fortsetzen/ }).click();
    await expect(page.locator('[data-suspended="true"]')).toHaveCount(0, { timeout: 5000 });
    expect(snoozes(ctx)[0].suspendedAt).toBeNull();
    // The card stays (held calls are not settled) and now only offers the plain decision.
    await expect(card).toBeVisible();
    expect((await decide(request, pb.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await b;
  });

  test('UI: Tippen auf „Erlauben & fortsetzen“ erlaubt und setzt fort', async ({ request, page }) => {
    const ctx = await setup(request, 'fs221t');
    const { b, pb } = await interrupt(request, ctx);
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await page.locator(`[data-approval="${pb.id}"]`).getByRole('button', { name: 'Erlauben & fortsetzen' }).click();
    await expect(page.getByText('Erlaubt, Zeitfreigabe läuft weiter')).toBeVisible();
    expect((await b).isError).toBeFalsy();
    expect(snoozes(ctx)[0].suspendedAt).toBeNull();
  });
});

test.describe('TC-222 Erneut unterbrochen / Zeit / Regeln', () => {
  test('nach dem Fortsetzen unterbricht eine neue Abweichung erneut; Regeln-Liste markiert „unterbrochen“; abgelaufen verschwindet', async ({ request, page }) => {
    const ctx = await setup(request, 'fs222');
    const { b, pb } = await interrupt(request, ctx);
    expect((await decide(request, pb.id, { decision: 'approve', resumePause: true }, ctx.user)).status()).toBe(200);
    await b;
    const c = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'C', __check: 'wechsel:0.9' });
    const pc = await waitHeld(request, ctx);
    expect(pc.rulePath).toBe('snooze-ki-mismatch');
    expect(pc.pauseCheck?.interrupted).toBeTruthy();
    expect(snoozes(ctx)[0].suspendedAt).not.toBeNull();

    const list = await (await request.get(`/api/upstreams/${ctx.up.id}/snoozes`, { headers: ctx.user })).json();
    expect(list).toEqual([expect.objectContaining({ suspendedAt: expect.any(String) })]);
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto(`/#/regeln/${ctx.up.id}`);
    await expect(page.getByTestId('pause-suspended')).toHaveText('unterbrochen');

    expect((await decide(request, pc.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await c;
    dbRun('update Snooze set until = ? where upstreamId = ?', iso(Date.now() - 1000), ctx.up.id);
    const running = await (await request.get('/api/running', { headers: ctx.user })).json();
    expect(running.pauses).toEqual([]);
  });
});
