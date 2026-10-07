// Zeitfreigabe with AI check (ADR-0029): TC-137…148. The e2e server's
// PAUSE_CHECK_URL points at the fake Clef (e2e/support/fakeClef.ts), whose
// verdict is driven only by the NEW call's `__check` argument. Units:
// apps/api/src/pausecheck/*.test.ts (prompt framing TC-147, validation and
// threshold TC-139/140, `narrow` TC-141, gate scoping TC-144, env TC-142).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, dbRun, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeState } from '../support/upstream.js';
import { decide, lastAudit, openStream, pendingList, startCall, waitPending, type Pending } from '../support/approval.js';
import { firstPushes, outbox, settle, subscribe } from '../support/push.js';
import { FAKE_CLEF } from '../support/paths.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
type Checked = Pending & { pauseCheck: { result: string; choice: string | null; score: number | null } | null };
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `KI ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function newClient(request: APIRequestContext, user: Identity, name: string) {
  const c = await runOAuthFlow(request, uniq(name), user);
  const row = dbAll('select id, name from McpClient where clientId = ?', c.clientId)[0];
  return { token: c.accessToken, id: row.id as number, name: row.name as string };
}

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`KI ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await newClient(request, user, `${prefix} A`);
  const userId = dbAll('select id from User where username = ?', user['Remote-User'])[0].id as number;
  return { user, userId, up, A };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
type Client = Ctx['A'];

/** Every request the fake Clef got about this upstream (its name is in every block). */
async function clefLog(request: APIRequestContext, ctx: Ctx) {
  const all = (await (await request.get(`${FAKE_CLEF}/control/log`)).json()) as { body: any; blocks: any[] }[];
  return all.filter((r) => r.blocks.some((b) => b.upstream === ctx.up.name));
}
const snoozes = (ctx: Ctx) => dbAll('select * from Snooze where upstreamId = ? order by id', ctx.up.id);
const upstreamCalls = async (request: APIRequestContext, ctx: Ctx, tool: string) => (await fakeState(request, ctx.up.tenant)).calls[tool] ?? 0;
const auditOf = (approvalId: string) => dbAll('select * from AuditEntry where approvalId = ?', approvalId)[0];

/** Holds `tool` for `client`, approves it with a 15-min Zeitfreigabe; returns the anchor's audit row. */
async function grant(request: APIRequestContext, ctx: Ctx, client: Client = ctx.A, tool = 'add_item', args: Record<string, unknown> = { item: 'Anker' }, scope = 'tool') {
  const held = startCall(request, ctx.up.slug, client.token, tool, args);
  const p = await waitPending(request, ctx.up.id, tool, ctx.user);
  const res = await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: scope }, ctx.user);
  expect(res.status(), await res.text()).toBe(200);
  expect((await held).isError).toBeFalsy();
  return auditOf(p.id);
}

/** A held call of this upstream that is not one of `known` (pending ids). */
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

async function denyHeld(request: APIRequestContext, ctx: Ctx, id: string) {
  expect((await decide(request, id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
}

async function setPolicy(request: APIRequestContext, ctx: Ctx, tool: string, policy: string) {
  const tools = (await (await request.get(`/api/upstreams/${ctx.up.id}/tools`, { headers: ctx.user })).json()).tools as { id: number; name: string }[];
  const t = tools.find((x) => x.name === tool)!;
  expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${t.id}`, { headers: ctx.user, data: { policy } })).status()).toBe(200);
}

test.describe('TC-137 Treffer', () => {
  test('passender Aufruf läuft durch: snooze+ki, Score 0.95, gleich; Clef bekam Anker, keine Aufrufe seither, neuen Aufruf', async ({ request }) => {
    const ctx = await setup(request, 'kc137');
    const anchor = await grant(request, ctx, ctx.A, 'add_item', { item: 'Milch' });
    const r = await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'Brot', __check: 'gleich:0.95' });
    expect(r.isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ policy: 'ALLOW', decisionPath: 'snooze+ki', outcome: 'FORWARDED', pauseCheckScore: 0.95, pauseCheckChoice: 'gleich', approvalId: null });
    expect((await pendingList(request, ctx.user)).filter((p) => p.upstream.id === ctx.up.id)).toEqual([]);
    const log = await clefLog(request, ctx);
    expect(log).toHaveLength(1);
    const { body, blocks } = log[0]!;
    expect(blocks.map((b) => [b.tool, b.arguments])).toEqual([
      ['add_item', { item: 'Milch' }],
      ['add_item', { item: 'Brot', __check: 'gleich:0.95' }],
    ]);
    expect(body.state).toContain('\n\nNo calls since.\n\n');
    // The anchor's intent summary, if it was there in time (stub: "Stub: add_item").
    if (body.state.includes('Summary of that call')) expect(body.state).toContain('"Stub: add_item"');
    expect(body.questions.richtung.type).toBe('choice');
    expect(Object.keys(body.questions.richtung.criteria)).toEqual(['gleich', 'richtungswechsel', 'ausweitung']);
    expect(body).not.toHaveProperty('model');
    // No tool result anywhere in the state (the anchor's result was "hinzugefügt: Milch").
    expect(body.state).not.toContain('hinzugefügt');
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ anchorAuditId: anchor.id, effect: 'ALLOW' })]);
  });
});

test.describe('TC-138 Abweichung', () => {
  test('beendet die Zeitfreigabe, hält den Aufruf (Karte + Push mit Grund); danach normales Fragen; neue Zeitfreigabe mit B als Anker', async ({ request }) => {
    const ctx = await setup(request, 'kc138');
    const endpoint = await subscribe(request, ctx.user);
    await grant(request, ctx);
    const before = await upstreamCalls(request, ctx, 'add_item');
    const b = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'B', __check: 'wechsel:0.9' });
    const pb = await waitHeld(request, ctx);
    expect(pb.rulePath).toBe('snooze-ki-mismatch');
    expect(pb.pauseCheck).toMatchObject({ result: 'mismatch', choice: 'richtungswechsel' });
    expect(auditOf(pb.id)).toMatchObject({ policy: 'ASK', decisionPath: 'snooze-ki-mismatch', outcome: 'PENDING', pauseCheckChoice: 'richtungswechsel' });
    expect(auditOf(pb.id).pauseCheckScore).toBeCloseTo(0.05, 5);
    expect(snoozes(ctx)).toEqual([]);
    await expect.poll(() => firstPushes(endpoint).filter((e) => e.payload.type === 'approval' && e.payload.id === pb.id).length).toBe(1);
    const push = firstPushes(endpoint).find((e) => e.payload.id === pb.id)!;
    expect(push.payload.note).toBe('KI-Prüfung: weicht ab (Richtungswechsel) – Zeitfreigabe beendet');

    // C: no pause any more -> plain ASK, Clef not asked.
    const clefBefore = (await clefLog(request, ctx)).length;
    const c = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'C', __check: 'gleich:0.99' });
    const pc = await waitHeld(request, ctx, [pb.id]);
    expect(pc.rulePath).toBe('policy:upstream-default');
    expect(pc.pauseCheck).toBeNull();
    expect((await clefLog(request, ctx)).length).toBe(clefBefore);
    await denyHeld(request, ctx, pc.id);
    expect((await c).isError).toBe(true);

    // Approving B with a new Zeitfreigabe: B is its anchor.
    expect((await decide(request, pb.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    expect((await b).isError).toBeFalsy();
    expect(auditOf(pb.id)).toMatchObject({ decisionPath: 'snooze-ki-mismatch+approved:page', outcome: 'FORWARDED' });
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ anchorAuditId: auditOf(pb.id).id })]);
    expect(await upstreamCalls(request, ctx, 'add_item')).toBe(before + 1);
  });
});

test.describe('TC-138 Abweichung beendet alle Zeitfreigaben des Zugangs', () => {
  test('zwei Zeitfreigaben von A (Tool + Upstream) enden beide; die von Client B und Sperren bleiben', async ({ request }) => {
    const ctx = await setup(request, 'kc138b');
    const B = await newClient(request, ctx.user, 'kc138b B');
    await grant(request, ctx); // A: TOOL add_item (anchor)
    await grant(request, ctx, ctx.A, 'list_items', {}, 'upstream'); // A: whole upstream
    await grant(request, ctx, B); // B: TOOL add_item
    expect(snoozes(ctx)).toHaveLength(3);
    const b = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'weg', __check: 'wechsel:0.9' });
    const pb = await waitHeld(request, ctx);
    expect(pb.rulePath).toBe('snooze-ki-mismatch');
    // Only B's Zeitfreigabe is left.
    expect(snoozes(ctx)).toEqual([expect.objectContaining({ mcpClientId: B.id, effect: 'ALLOW' })]);
    // A's next call, even one the upstream-wide pause covered, is a plain question now.
    const c = startCall(request, ctx.up.slug, ctx.A.token, 'list_items', { __check: 'gleich:0.99' });
    const pc = await waitHeld(request, ctx, [pb.id]);
    expect(pc.rulePath).toBe('policy:upstream-default');
    await denyHeld(request, ctx, pc.id);
    await denyHeld(request, ctx, pb.id);
    await c;
    await b;
  });
});

test.describe('TC-139 Schwelle', () => {
  test('gleich genau 0.8 läuft durch, 0.7999 weicht ab', async ({ request }) => {
    const ctx = await setup(request, 'kc139');
    await grant(request, ctx);
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'x', __check: 'gleich:0.8' })).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze+ki', pauseCheckScore: 0.8 });
    const held = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'y', __check: 'gleich:0.7999' });
    const p = await waitHeld(request, ctx);
    expect(p.rulePath).toBe('snooze-ki-mismatch');
    expect(snoozes(ctx)).toEqual([]);
    await denyHeld(request, ctx, p.id);
    await held;
  });
});

test.describe('TC-140 Fehler schließt (Sicherheit)', () => {
  test('error, hang, garbage: gehalten (snooze-ki-error), Zeitfreigabe bleibt, nie weitergeleitet', async ({ request }) => {
    test.setTimeout(90_000);
    const ctx = await setup(request, 'kc140');
    await grant(request, ctx);
    const pause = snoozes(ctx);
    expect(pause).toHaveLength(1);
    const before = await upstreamCalls(request, ctx, 'add_item');
    for (const mode of ['error', 'hang', 'garbage:nojson', 'garbage:norichtung', 'garbage:nan', 'garbage:gt1', 'garbage:badchoice', 'garbage:nogleich']) {
      const t0 = Date.now();
      const held = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: mode, __check: mode });
      const p = await waitHeld(request, ctx);
      if (mode === 'hang') expect(Date.now() - t0).toBeLessThan(4500); // aborted at 1.5 s, not 5 s
      expect(p.rulePath, mode).toBe('snooze-ki-error');
      expect(p.pauseCheck, mode).toEqual({ result: 'error', choice: null, score: null });
      expect(auditOf(p.id), mode).toMatchObject({ policy: 'ASK', decisionPath: 'snooze-ki-error', pauseCheckScore: null, pauseCheckChoice: null });
      expect(snoozes(ctx), mode).toEqual(pause);
      await denyHeld(request, ctx, p.id);
      expect((await held).isError, mode).toBe(true);
      expect(await upstreamCalls(request, ctx, 'add_item'), mode).toBe(before);
    }
  });
});

test.describe('TC-141 Nur Zeitfreigaben werden geprüft', () => {
  test('Regel-ALLOW, Regel-DENY, Sperre, Fragen ohne Zeitfreigabe, neues Tool: Clef nie gefragt; DENY bleibt DENY', async ({ request }) => {
    const ctx = await setup(request, 'kc141');
    await grant(request, ctx, ctx.A, 'add_item', { item: 'Anker' }, 'upstream');
    const n0 = (await clefLog(request, ctx)).length;
    // Rule ALLOW: forwarded, unchecked.
    await setPolicy(request, ctx, 'list_items', 'ALLOW');
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'list_items', { __check: 'wechsel:0.99' })).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'policy:tool', outcome: 'FORWARDED', pauseCheckScore: null });
    // Rule DENY under a live UPSTREAM allow pause: denied, even if the model would say "gleich".
    await setPolicy(request, ctx, 'delete_all', 'DENY');
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'delete_all', { __check: 'gleich:0.99' })).isError).toBe(true);
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'policy:tool', outcome: 'DENIED' });
    expect(await upstreamCalls(request, ctx, 'delete_all')).toBe(0);
    // Deny pause (Sperre) on add_item: denied at once.
    const now = new Date();
    dbRun(
      `insert into Snooze (userId, upstreamId, mcpClientId, scope, effect, toolName, until, createdAt) values (?, ?, ?, 'TOOL', 'DENY', 'add_item', ?, ?)`,
      ctx.userId, ctx.up.id, ctx.A.id,
      new Date(now.getTime() + 15 * 60_000).toISOString().replace('Z', '+00:00'),
      now.toISOString().replace('Z', '+00:00'),
    );
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { __check: 'gleich:0.99' })).isError).toBe(true);
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze-deny' });
    // Plain ASK (another access, no pause): held.
    const B = await newClient(request, ctx.user, 'kc141 B');
    const hb = startCall(request, ctx.up.slug, B.token, 'add_item', { __check: 'gleich:0.99' });
    const pb = await waitHeld(request, ctx);
    expect(pb.rulePath).toBe('policy:upstream-default');
    await denyHeld(request, ctx, pb.id);
    await hb;
    // A new tool under the live UPSTREAM pause: asks as before.
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'brand_new', description: 'Neu.' });
    expect((await request.post(`/api/upstreams/${ctx.up.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(200);
    const hn = startCall(request, ctx.up.slug, ctx.A.token, 'brand_new', { __check: 'gleich:0.99' });
    const pn = await waitHeld(request, ctx);
    expect(pn.rulePath).toBe('new-tool');
    await denyHeld(request, ctx, pn.id);
    await hn;
    expect((await clefLog(request, ctx)).length).toBe(n0);
  });
});

test.describe('TC-142 Schalter', () => {
  test('ausgeschaltet: blinde Zeitfreigabe (snooze), Clef nie gefragt; bleibt gespeichert; anderer Nutzer unabhängig; nur mit Remote-User', async ({ request }) => {
    const ctx = await setup(request, 'kc142');
    const me = await (await request.get('/api/me', { headers: ctx.user })).json();
    expect(me).toMatchObject({ pauseCheck: true, pauseCheckAvailable: true });
    const off = await request.patch('/api/me', { headers: ctx.user, data: { pauseCheck: false } });
    expect(off.status()).toBe(200);
    expect(await off.json()).toMatchObject({ pauseCheck: false });
    expect((await (await request.get('/api/me', { headers: ctx.user })).json()).pauseCheck).toBe(false);
    // Another user is independent.
    expect((await (await request.get('/api/me', { headers: freshUser('kc142o') })).json()).pauseCheck).toBe(true);
    await grant(request, ctx);
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'z', __check: 'wechsel:0.99' })).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze', outcome: 'FORWARDED', pauseCheckScore: null });
    expect(await clefLog(request, ctx)).toEqual([]);
    // Only via /api with Remote-User: an MCP token is no identity there; bad bodies are refused.
    expect((await request.patch('/api/me', { headers: { Authorization: `Bearer ${ctx.A.token}` }, data: { pauseCheck: true } })).status()).toBe(401);
    for (const bad of [{ pauseCheck: 'yes' }, {}, { pauseCheck: true, extra: 1 }]) {
      expect((await request.patch('/api/me', { headers: ctx.user, data: bad })).status()).toBe(400);
    }
    expect((await (await request.get('/api/me', { headers: ctx.user })).json()).pauseCheck).toBe(false);
  });

  test('Einstellungen: Schalter „KI-Prüfung (Clef)“, übersteht Neuladen; ohne PAUSE_CHECK_URL kein Schalter', async ({ page }) => {
    const user = freshUser('kc142ui');
    await page.setExtraHTTPHeaders(user);
    await page.goto('/#/einstellungen');
    const sw = page.getByRole('checkbox', { name: 'KI-Prüfung (Clef)' });
    await expect(sw).toBeChecked();
    await sw.uncheck();
    await expect(page.getByText('KI-Prüfung ausgeschaltet', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'KI-Prüfung (Clef)' })).not.toBeChecked();
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('einstellungen-ki.png') });
    // Feature off on the server (no PAUSE_CHECK_URL): the API says so, no switch.
    await page.route('**/api/me', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), pauseCheckAvailable: false } });
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Upstreams' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'KI-Prüfung (Clef)' })).toHaveCount(0);
  });
});

test.describe('TC-143 Störung', () => {
  test('Karte + ein Push; Ausschalten entfernt sie und Zeitfreigaben gelten blind; ein erfolgreicher Check räumt sie ab; nur dieser Nutzer', async ({ request, page }) => {
    const ctx = await setup(request, 'kc143');
    const endpoint = await subscribe(request, ctx.user);
    const other = freshUser('kc143o');
    const otherStream = await openStream(other);
    await grant(request, ctx);
    const pausePushes = () => outbox(endpoint).filter((e) => e.payload.type === 'pausecheck');

    const h1 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: '1', __check: 'error' });
    const p1 = await waitHeld(request, ctx);
    await expect.poll(() => pausePushes().length).toBe(1);
    expect(pausePushes()[0]!.payload).toEqual({ type: 'pausecheck', state: 'unreachable' });
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const card = page.locator('[data-pausecheck-fault]');
    await expect(card).toContainText('KI-Prüfung nicht erreichbar – Zeitfreigaben fragen wieder nach');
    await expect(page.locator(`[data-approval="${p1.id}"]`)).toContainText('KI-Prüfung nicht erreichbar');
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('freigaben-stoerung.png') });
    // A second failure in the same outage: no second push.
    await denyHeld(request, ctx, p1.id);
    await h1;
    const h2 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: '2', __check: 'error' });
    const p2 = await waitHeld(request, ctx);
    await denyHeld(request, ctx, p2.id);
    await h2;
    await settle();
    expect(pausePushes()).toHaveLength(1);
    // Turn the check off from the card: card gone, next paused call blind.
    await card.getByRole('button', { name: 'KI-Prüfung ausschalten' }).click();
    await expect(card).toHaveCount(0);
    expect((await (await request.get('/api/me', { headers: ctx.user })).json()).pauseCheck).toBe(false);
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: '3', __check: 'error' })).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze' });

    // On again; a failure raises the card, the next successful check clears it.
    expect((await request.patch('/api/me', { headers: ctx.user, data: { pauseCheck: true } })).status()).toBe(200);
    const h4 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: '4', __check: 'error' });
    const p4 = await waitHeld(request, ctx);
    await page.reload();
    await expect(card).toBeVisible();
    await denyHeld(request, ctx, p4.id);
    await h4;
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: '5', __check: 'gleich:0.9' })).isError).toBeFalsy();
    await expect(card).toHaveCount(0);
    await settle(300);
    expect(pausePushes()).toHaveLength(1); // cooldown: still one push
    await otherStream.close();
    expect(otherStream.events.filter((e) => e.event === 'pausecheck').every((e) => e.data.failing === false)).toBe(true);
  });
});

test.describe('TC-144 Aufrufe seither und Trennung', () => {
  test('B1, B2 erscheinen bei B3 in Reihenfolge; höchstens 8; fremde Zugänge/Zeitfreigaben nie; Abweichung bei Zugang 1 beendet nur dessen Zeitfreigabe', async ({ request }) => {
    test.setTimeout(60_000);
    const ctx = await setup(request, 'kc144');
    const B = await newClient(request, ctx.user, 'kc144 B');
    await grant(request, ctx, ctx.A, 'add_item', { item: 'A0' });
    await grant(request, ctx, B, 'add_item', { item: 'X0' });
    // Interleaved calls of the other access.
    for (const i of [1, 2]) {
      expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: `A${i}` })).isError).toBeFalsy();
      expect((await callTool(request, ctx.up.slug, B.token, 'add_item', { item: `X${i}` })).isError).toBeFalsy();
    }
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'A3' })).isError).toBeFalsy();
    let log = await clefLog(request, ctx);
    const items = (r: { blocks: any[] }) => r.blocks.map((b) => b.arguments.item);
    expect(items(log[log.length - 1]!)).toEqual(['A0', 'A1', 'A2', 'A3']);
    // At most 8 calls since, the newest, in order.
    for (let i = 4; i <= 12; i++) expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: `A${i}` })).isError).toBeFalsy();
    log = await clefLog(request, ctx);
    expect(items(log[log.length - 1]!)).toEqual(['A0', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12']);
    // Mismatch on A ends only A's pause; B's keeps working.
    const h = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'A-weg', __check: 'ausweitung:0.9' });
    const p = await waitHeld(request, ctx);
    expect(p.pauseCheck).toMatchObject({ result: 'mismatch', choice: 'ausweitung' });
    expect(snoozes(ctx).map((s) => s.mcpClientId)).toEqual([B.id]);
    expect((await callTool(request, ctx.up.slug, B.token, 'add_item', { item: 'X3' })).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze+ki', mcpClientId: B.id });
    log = await clefLog(request, ctx);
    expect(items(log[log.length - 1]!)).toEqual(['X0', 'X1', 'X2', 'X3']);
    // A new pause anchored on the held call: its "calls since" start empty.
    expect((await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    await h;
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'A13' })).isError).toBeFalsy();
    log = await clefLog(request, ctx);
    expect(items(log[log.length - 1]!)).toEqual(['A-weg', 'A13']);
  });
});

test.describe('TC-145 Wartende Aufrufe beim Erteilen (TC-128-Pfad)', () => {
  test('passender wird +approved:pause mit Score weitergeleitet, abweichender bleibt gehalten und beendet die Zeitfreigabe', async ({ request }) => {
    const ctx = await setup(request, 'kc145');
    const h1 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'H1' });
    const p1 = await waitHeld(request, ctx);
    const h2 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'H2', __check: 'gleich:0.95' });
    const p2 = await waitHeld(request, ctx, [p1.id]);
    const h3 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'H3', __check: 'wechsel:0.9' });
    const p3 = await waitHeld(request, ctx, [p1.id, p2.id]);
    const res = await decide(request, p1.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user);
    expect(res.status()).toBe(200);
    expect((await h1).isError).toBeFalsy();
    expect((await h2).isError).toBeFalsy();
    expect(auditOf(p2.id)).toMatchObject({ outcome: 'FORWARDED', decisionPath: 'policy:upstream-default+approved:pause', pauseCheckScore: 0.95, pauseCheckChoice: 'gleich' });
    // H3 stays held with the reason; the pause is gone.
    await expect
      .poll(async () => ((await pendingList(request, ctx.user)) as Checked[]).find((p) => p.id === p3.id)?.pauseCheck?.result)
      .toBe('mismatch');
    expect(snoozes(ctx)).toEqual([]);
    expect(auditOf(p3.id)).toMatchObject({ outcome: 'PENDING', pauseCheckChoice: 'richtungswechsel' });
    // Clef saw H2 with anchor H1 and no calls since; H3 with H2 as call since.
    const log = await clefLog(request, ctx);
    expect(log.map((r) => r.blocks.map((b) => b.arguments.item))).toEqual([['H1', 'H2'], ['H1', 'H2', 'H3']]);
    await denyHeld(request, ctx, p3.id);
    expect((await h3).isError).toBe(true);
  });
});

test.describe('TC-146 Zeitfreigabe ohne Anker', () => {
  test('alte Zeile (anchorAuditId null): blind (snooze), Clef nie gefragt', async ({ request }) => {
    const ctx = await setup(request, 'kc146');
    const now = new Date();
    dbRun(
      `insert into Snooze (userId, upstreamId, mcpClientId, scope, effect, toolName, until, createdAt) values (?, ?, ?, 'TOOL', 'ALLOW', 'add_item', ?, ?)`,
      ctx.userId, ctx.up.id, ctx.A.id,
      new Date(now.getTime() + 15 * 60_000).toISOString().replace('Z', '+00:00'),
      now.toISOString().replace('Z', '+00:00'),
    );
    expect(snoozes(ctx)[0].anchorAuditId).toBeNull();
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'alt', __check: 'wechsel:0.99' })).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze', outcome: 'FORWARDED', pauseCheckScore: null });
    expect(await clefLog(request, ctx)).toEqual([]);
  });
});

test.describe('TC-148 UI', () => {
  test('Karte zeigt den Grund; Verlauf-Detail „KI-Prüfung: passt (0,95)“ und die Abweichung; 390×844 ohne Querscrollen', async ({ request, page }) => {
    const ctx = await setup(request, 'kc148');
    await grant(request, ctx);
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'passt', __check: 'gleich:0.95' })).isError).toBeFalsy();
    const okId = lastAudit(ctx.up.id).id as number;
    const held = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'weicht ab', __check: 'wechsel:0.9' });
    const p = await waitHeld(request, ctx);
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const card = page.locator(`[data-approval="${p.id}"]`);
    await expect(card.locator('[data-pause-check="mismatch"]')).toHaveText('KI-Prüfung: weicht ab (Richtungswechsel) – Zeitfreigabe beendet');
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('karte-weicht-ab.png'), fullPage: true });
    await denyHeld(request, ctx, p.id);
    await held;
    await page.goto(`/#/verlauf/${okId}`);
    await expect(page.getByTestId('pause-check')).toHaveText('KI-Prüfung: passt (0,95)');
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('verlauf-passt.png'), fullPage: true });
    await page.goto(`/#/verlauf/${auditOf(p.id).id}`);
    await expect(page.getByTestId('pause-check')).toHaveText('KI-Prüfung: weicht ab (Richtungswechsel, 0,05) – Zeitfreigabe beendet');
    await expect(page.getByText('Zeitfreigabe, KI-Prüfung: weicht ab – Zeitfreigabe beendet → abgelehnt in der App')).toBeVisible();
    expect(await noHScroll(page)).toBe(false);
  });
});
