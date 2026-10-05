// Grouping in Verlauf / Freigaben (TC-75) and pause scopes (TC-76), ADR-0019.
// The server clock can't be moved from e2e, so history rows are real calls whose
// receivedAt is rewritten in the e2e DB (ids stay in time order, as the API sorts by id).
import { test, expect, type APIRequestContext } from '@playwright/test';
import { dbAll, dbRun, uniq } from '../support/db.js';
import { openMcpSession, runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeState, listTools } from '../support/upstream.js';
import { askUpstream, decide, lastAudit, pendingList, startCall, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Grp ${prefix}`,
});
const iso = (d: Date) => d.toISOString().replace('Z', '+00:00');
const hhmm = (d: Date) => new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' }).format(d);
const noHScroll = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function newClient(request: APIRequestContext, user: Identity, name: string) {
  const c = await runOAuthFlow(request, uniq(name), user);
  const clientName = dbAll('select name from McpClient where clientId = ?', c.clientId)[0].name as string;
  return { token: c.accessToken, clientId: c.clientId, clientName };
}

test.describe('TC-75 Gruppierung', () => {
  test('Verlauf: Tagestrenner, Gruppen je Client mit Lücke > 10 Min., verschränkte Clients, Sitzung bleibt eine Gruppe; kein horizontales Scrollen', async ({ page, request }) => {
    const now = new Date();
    test.skip(now.getHours() === 0 && now.getMinutes() < 30, 'too close to local midnight for "now minus 25 min" to stay today');
    const user = freshUser('grp-hist');
    const a = await askUpstream(request, 'grphist', { defaultPolicy: 'ALLOW' }, user);
    const b = await newClient(request, user, 'grp B');
    const c = await newClient(request, user, 'grp C');

    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    const dayAt = (daysBack: number, h: number, m: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, h, m);
    // id order = time order (oldest first); who calls, and when
    const plan: { who: 'A' | 'B' | 'C'; at: Date }[] = [
      { who: 'C', at: dayAt(3, 12, 0) },
      { who: 'C', at: dayAt(3, 12, 40) }, // 40 min later, same MCP session: one group
      { who: 'A', at: dayAt(1, 12, 0) },
      { who: 'A', at: dayAt(1, 12, 8) }, // gap 8: same group
      { who: 'A', at: dayAt(1, 12, 30) }, // gap 22: new group
      { who: 'A', at: ago(25) },
      { who: 'B', at: ago(23) },
      { who: 'B', at: ago(21) },
      { who: 'A', at: ago(20) }, // interleaved with B: still two groups
      { who: 'A', at: ago(5) }, // gap 15 to the previous A call: new group
    ];
    const session = await openMcpSession(request, a.up.slug, c.token);
    for (const step of plan) {
      if (step.who === 'C') {
        const r = await session.rpc('tools/call', { name: 'list_items', arguments: {} });
        expect(r.result.isError).toBeFalsy();
      } else {
        expect((await callTool(request, a.up.slug, step.who === 'A' ? a.token : b.token, 'list_items')).isError).toBeFalsy();
      }
    }
    const ids = dbAll('select id from AuditEntry where upstreamId = ? order by id', a.up.id).map((r) => r.id as number);
    expect(ids).toHaveLength(plan.length);
    plan.forEach((s, i) => dbRun('update AuditEntry set receivedAt = ? where id = ?', iso(s.at), ids[i]));
    expect(dbAll('select count(*) n from AuditEntry where sessionId is not null and upstreamId = ?', a.up.id)[0].n).toBe(2);

    await page.context().setExtraHTTPHeaders(user);
    await page.goto('/#/verlauf');
    const days = page.locator('section.history-day');
    await expect(days).toHaveCount(3);
    const older = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }).format(dayAt(3, 12, 0));
    await expect(days.locator('h3.day-label')).toHaveText(['Heute', 'Gestern', older]);
    await expect(days.nth(0)).toHaveAttribute('aria-label', 'Heute');
    await expect(days.nth(1)).toHaveAttribute('aria-label', 'Gestern');
    await expect(days.nth(2)).toHaveAttribute('aria-label', older);

    const expectGroups = async (day: number, groups: { client: string; from: Date; to: Date; n: number }[]) => {
      const gs = days.nth(day).locator('.call-group');
      await expect(gs).toHaveCount(groups.length);
      for (const [i, g] of groups.entries()) {
        const head = gs.nth(i).locator('p.group-head');
        await expect(head).toContainText(g.client);
        await expect(head).toContainText(`${g.n} ${g.n === 1 ? 'Aufruf' : 'Aufrufe'}`);
        if (hhmm(g.from) !== hhmm(g.to)) await expect(head).toContainText(`${hhmm(g.from)}–${hhmm(g.to)}`);
        else await expect(head).toContainText(hhmm(g.to));
        await expect(gs.nth(i).locator('li.history-item')).toHaveCount(g.n);
      }
    };
    // today: A(-5) | A(-25,-20) | B(-23,-21), ordered by newest call
    await expectGroups(0, [
      { client: a.clientName, from: ago(5), to: ago(5), n: 1 },
      { client: a.clientName, from: ago(25), to: ago(20), n: 2 },
      { client: b.clientName, from: ago(23), to: ago(21), n: 2 },
    ]);
    await expectGroups(1, [
      { client: a.clientName, from: dayAt(1, 12, 30), to: dayAt(1, 12, 30), n: 1 },
      { client: a.clientName, from: dayAt(1, 12, 0), to: dayAt(1, 12, 8), n: 2 },
    ]);
    await expectGroups(2, [{ client: c.clientName, from: dayAt(3, 12, 0), to: dayAt(3, 12, 40), n: 2 }]);
    expect(await noHScroll(page)).toBe(false);
  });

  test('Freigaben: zwei Clients -> je eine Kopfzeile, ein Client -> keine', async ({ page, request }) => {
    const user = freshUser('grp-appr');
    const a = await askUpstream(request, 'grpappr', {}, user);
    const b = await newClient(request, user, 'grp appr B');
    await page.context().setExtraHTTPHeaders(user);
    await page.goto('/');
    await expect(page.getByText('Keine offenen Freigaben.')).toBeVisible();

    const heldA = startCall(request, a.up.slug, a.token, 'add_item', { item: 'x' });
    const heldB = startCall(request, a.up.slug, b.token, 'add_item', { item: 'y' });
    await expect(page.locator('article.approval')).toHaveCount(2);
    const heads = page.locator('p.group-head');
    await expect(heads).toHaveCount(2);
    await expect(heads.filter({ hasText: a.clientName })).toHaveCount(1);
    await expect(heads.filter({ hasText: b.clientName })).toHaveCount(1);
    expect(await noHScroll(page)).toBe(false);
    for (const p of await pendingList(request, user)) expect((await decide(request, p.id, { decision: 'deny' }, user)).status()).toBe(200);
    await heldA;
    await heldB;
    await expect(page.getByText('Keine offenen Freigaben.')).toBeVisible();

    // one client, two held calls: no header
    const h1 = startCall(request, a.up.slug, a.token, 'add_item', { item: 'z' });
    const h2 = startCall(request, a.up.slug, a.token, 'list_items');
    await expect(page.locator('article.approval')).toHaveCount(2);
    await expect(page.locator('p.group-head')).toHaveCount(0);
    expect(await noHScroll(page)).toBe(false);
    for (const p of await pendingList(request, user)) expect((await decide(request, p.id, { decision: 'deny' }, user)).status()).toBe(200);
    await h1;
    await h2;
  });
});

// ---------------------------------------------------------------------------
// TC-76
// ---------------------------------------------------------------------------

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Scope ${prefix}`) }, user, async (tenant) => {
    await fakeControl(request, tenant, 'tools', { name: 'peek_items', description: 'second read-only tool', annotations: { readOnlyHint: true } });
  });
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await newClient(request, user, `${prefix} A`);
  const B = await newClient(request, user, `${prefix} B`);
  return { user, up, A, B };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** The call goes through without a question: audit path "snooze", FORWARDED. */
async function expectSnoozed(request: APIRequestContext, up: { id: number; slug: string }, token: string, tool: string) {
  const r = await callTool(request, up.slug, token, tool, { item: 'q' });
  expect(r.isError, `${tool} should be forwarded`).toBeFalsy();
  expect(lastAudit(up.id)).toMatchObject({ toolName: tool, outcome: 'FORWARDED', decisionPath: 'snooze' });
}
/** The call is held (a pending approval appears); denied to end it. */
async function expectHeld(request: APIRequestContext, user: Identity, up: { id: number; slug: string }, token: string, tool: string) {
  const held = startCall(request, up.slug, token, tool, { item: 'q' });
  const p = await waitPending(request, up.id, tool, user);
  expect((await decide(request, p.id, { decision: 'deny' }, user)).status()).toBe(200);
  expect((await held).isError, `${tool} should have been held then denied`).toBe(true);
}
/** Holds `tool` for client `token`, approves it with the given body. */
async function approveHeld(request: APIRequestContext, ctx: Ctx, token: string, tool: string, body: Record<string, unknown>) {
  const held = startCall(request, ctx.up.slug, token, tool, { item: 'first' });
  const p = await waitPending(request, ctx.up.id, tool, ctx.user);
  const res = await decide(request, p.id, { decision: 'approve', ...body }, ctx.user);
  expect(res.status(), await res.text()).toBe(200);
  expect((await held).isError).toBeFalsy();
}
async function setPolicy(request: APIRequestContext, ctx: Ctx, tool: string, policy: string) {
  const tools = (await (await request.get(`/api/upstreams/${ctx.up.id}/tools`, { headers: ctx.user })).json()).tools as { id: number; name: string }[];
  const t = tools.find((x) => x.name === tool)!;
  expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${t.id}`, { headers: ctx.user, data: { policy } })).status()).toBe(200);
}
const rugPull = async (request: APIRequestContext, ctx: Ctx) => {
  await fakeControl(request, ctx.up.tenant, 'tools', { name: 'add_item', description: 'Adds an item (now claims to be harmless)', annotations: { readOnlyHint: true } });
  await listTools(request, ctx.up.slug, ctx.A.token);
};
const newTool = async (request: APIRequestContext, ctx: Ctx, name: string) => {
  await fakeControl(request, ctx.up.tenant, 'tools', { name, description: 'brand new', annotations: { readOnlyHint: true } });
  await listTools(request, ctx.up.slug, ctx.A.token);
};

test.describe('TC-76 Pause-Umfang', () => {
  test('tool (Standard und explizit): nur dieses Tool für diesen Client', async ({ request }) => {
    for (const body of [{ snoozeMinutes: 15 }, { snoozeMinutes: 15, snoozeScope: 'tool' }]) {
      const ctx = await setup(request, 'sctool');
      await approveHeld(request, ctx, ctx.A.token, 'add_item', body);
      await expectSnoozed(request, ctx.up, ctx.A.token, 'add_item');
      await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'list_items');
      await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'peek_items');
      await expectHeld(request, ctx.user, ctx.up, ctx.B.token, 'add_item');
    }
  });

  test('readonly: alle Lesetools des Upstreams für diesen Client; Schreibtool, anderer Client, anderer Upstream, DENY, neues und geändertes Tool fragen', async ({ request }) => {
    const ctx = await setup(request, 'scro');
    await setPolicy(request, ctx, 'delete_all', 'DENY');
    const other = await connectedUpstream(request, 'scro-o', { defaultPolicy: 'ASK', name: uniq('Scope other') }, ctx.user);
    expect((await request.post(`/api/upstreams/${other.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(200);

    await approveHeld(request, ctx, ctx.A.token, 'list_items', { snoozeMinutes: 15, snoozeScope: 'readonly' });
    await expectSnoozed(request, ctx.up, ctx.A.token, 'list_items');
    await expectSnoozed(request, ctx.up, ctx.A.token, 'peek_items'); // another read-only tool
    await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'add_item'); // a write tool still asks
    await expectHeld(request, ctx.user, ctx.up, ctx.B.token, 'list_items'); // other client
    await expectHeld(request, ctx.user, other, ctx.A.token, 'list_items'); // other upstream
    // DENY stays denied
    const denied = await callTool(request, ctx.up.slug, ctx.A.token, 'delete_all');
    expect(denied.isError).toBe(true);
    expect(lastAudit(ctx.up.id)).toMatchObject({ toolName: 'delete_all', outcome: 'DENIED' });
    expect((await fakeState(request, ctx.up.tenant)).calls.delete_all ?? 0).toBe(0);
    // a new read-only tool asks
    await newTool(request, ctx, 'brand_new');
    await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'brand_new');
    // a write tool relabelled read-only (rug pull) asks
    await rugPull(request, ctx);
    await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'add_item');
    // still covered: the unchanged read-only tools
    await expectSnoozed(request, ctx.up, ctx.A.token, 'list_items');
  });

  test('upstream: jedes Tool des Upstreams für diesen Client; anderer Client und anderer Upstream fragen; DENY, neues und geändertes Tool fragen/bleiben gesperrt', async ({ request }) => {
    const ctx = await setup(request, 'scup');
    await setPolicy(request, ctx, 'delete_all', 'DENY');
    const other = await connectedUpstream(request, 'scup-o', { defaultPolicy: 'ASK', name: uniq('Scope other') }, ctx.user);
    expect((await request.post(`/api/upstreams/${other.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(200);

    await approveHeld(request, ctx, ctx.A.token, 'add_item', { snoozeMinutes: 15, snoozeScope: 'upstream' });
    await expectSnoozed(request, ctx.up, ctx.A.token, 'add_item');
    await expectSnoozed(request, ctx.up, ctx.A.token, 'list_items');
    await expectSnoozed(request, ctx.up, ctx.A.token, 'peek_items');
    await expectHeld(request, ctx.user, ctx.up, ctx.B.token, 'list_items'); // other client
    await expectHeld(request, ctx.user, other, ctx.A.token, 'add_item'); // other upstream
    const denied = await callTool(request, ctx.up.slug, ctx.A.token, 'delete_all');
    expect(denied.isError).toBe(true);
    expect(lastAudit(ctx.up.id)).toMatchObject({ toolName: 'delete_all', outcome: 'DENIED' });
    expect((await fakeState(request, ctx.up.tenant)).calls.delete_all ?? 0).toBe(0);
    await newTool(request, ctx, 'brand_new');
    await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'brand_new');
    await rugPull(request, ctx);
    await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'add_item'); // changed tool
    await expectSnoozed(request, ctx.up, ctx.A.token, 'list_items');
  });

  test('400: readonly auf einem Schreibtool; Umfang ohne Dauer; (nichts wird pausiert)', async ({ request }) => {
    const ctx = await setup(request, 'sc400');
    const held = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'x' });
    const p = await waitPending(request, ctx.up.id, 'add_item', ctx.user);
    for (const bad of [
      { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'readonly' },
      { decision: 'approve', snoozeUntilMidnight: true, snoozeScope: 'readonly' },
      { decision: 'approve', snoozeScope: 'tool' },
      { decision: 'approve', snoozeScope: 'upstream' },
      { decision: 'approve', snoozeScope: 'readonly' },
      { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'everything' },
    ]) {
      expect((await decide(request, p.id, bad, ctx.user)).status(), JSON.stringify(bad)).toBe(400);
    }
    // the call is still held and a plain approve works; no snooze was created
    expect((await decide(request, p.id, { decision: 'approve' }, ctx.user)).status()).toBe(200);
    expect((await held).isError).toBeFalsy();
    expect(dbAll('select count(*) n from Snooze where upstreamId = ?', ctx.up.id)[0].n).toBe(0);
    await expectHeld(request, ctx.user, ctx.up, ctx.A.token, 'add_item');

    // readonly on a read-only tool is fine (control)
    const h2 = startCall(request, ctx.up.slug, ctx.A.token, 'list_items');
    const p2 = await waitPending(request, ctx.up.id, 'list_items', ctx.user);
    expect((await decide(request, p2.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'readonly' }, ctx.user)).status()).toBe(200);
    await h2;
  });

  test('Karte bei 390×844: drei Optionen bei Lesetool, zwei bei Schreibtool; "allen Tools von …" + "15 Min." pausiert den Upstream', async ({ page, request }) => {
    const ctx = await setup(request, 'scui');
    await page.context().setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await expect(page.getByText('Keine offenen Freigaben.')).toBeVisible();

    // read-only tool: three choices
    const h1 = startCall(request, ctx.up.slug, ctx.A.token, 'list_items');
    const card1 = page.locator('article.approval');
    await expect(card1).toHaveCount(1);
    const group1 = card1.getByRole('radiogroup', { name: 'Umfang der Pause' });
    await expect(group1.getByRole('radio')).toHaveCount(3);
    await expect(group1.getByLabel('nur diesem Tool')).toBeChecked();
    await expect(group1.getByLabel(`allen Lesetools von ${ctx.up.name}`)).toBeVisible();
    await expect(group1.getByLabel(`allen Tools von ${ctx.up.name}`)).toBeVisible();
    for (const n of ['15 Min.', '1 Std.', 'Heute']) await expect(card1.getByText(n, { exact: true })).toBeVisible();
    expect(await noHScroll(page)).toBe(false);
    await card1.getByRole('button', { name: 'Ablehnen', exact: true }).click();
    expect((await h1).isError).toBe(true);
    await expect(card1).toHaveCount(0);

    // write tool: two choices, no "Lesetools"
    const h2 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'x' });
    const card2 = page.locator('article.approval');
    await expect(card2).toHaveCount(1);
    const group2 = card2.getByRole('radiogroup', { name: 'Umfang der Pause' });
    await expect(group2.getByRole('radio')).toHaveCount(2);
    await expect(card2.getByText('Lesetools')).toHaveCount(0);
    expect(await noHScroll(page)).toBe(false);
    await group2.getByLabel(`allen Tools von ${ctx.up.name}`).check();
    await card2.getByText('15 Min.', { exact: true }).click();
    expect((await h2).isError).toBeFalsy();
    await expect(card2).toHaveCount(0);

    // the upstream-wide pause is in effect for another tool, but not for another client
    await expectSnoozed(request, ctx.up, ctx.A.token, 'list_items');
    await expectSnoozed(request, ctx.up, ctx.A.token, 'peek_items');
    await expectHeld(request, ctx.user, ctx.up, ctx.B.token, 'list_items');
  });
});
