// Deny pause, "Ablehnen und nicht mehr fragen" (ADR-0026): TC-122…125. The
// precedence table (TC-121) is a unit test in apps/api/src/lib/policy.test.ts
// and apps/api/src/approval/snooze.test.ts.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeState } from '../support/upstream.js';
import { decide, lastAudit, pendingList, startCall, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Deny ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function newClient(request: APIRequestContext, user: Identity, name: string) {
  const c = await runOAuthFlow(request, uniq(name), user);
  const row = dbAll('select id, name from McpClient where clientId = ?', c.clientId)[0];
  return { token: c.accessToken, id: row.id as number, name: row.name as string };
}

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Deny ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await newClient(request, user, `${prefix} A`);
  const B = await newClient(request, user, `${prefix} B`);
  return { user, up, A, B };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const snoozeRows = (upstreamId: number) => dbAll('select * from Snooze where upstreamId = ? order by id', upstreamId);

/** Holds `tool` for `token`, then decides with `body`; returns the agent's result. */
async function decideHeld(request: APIRequestContext, ctx: Ctx, token: string, tool: string, body: Record<string, unknown>) {
  const held = startCall(request, ctx.up.slug, token, tool, { item: 'first' });
  const p = await waitPending(request, ctx.up.id, tool, ctx.user);
  const res = await decide(request, p.id, body, ctx.user);
  expect(res.status(), await res.text()).toBe(200);
  return { result: await held, approvalId: p.id, response: await res.json() };
}

/** Refused at once: no hold, nothing forwarded, audit DENIED snooze-deny. */
async function expectBlocked(request: APIRequestContext, ctx: Ctx, token: string, tool: string) {
  const before = (await fakeState(request, ctx.up.tenant)).calls[tool] ?? 0;
  const t0 = Date.now();
  const r = await callTool(request, ctx.up.slug, token, tool, { item: 'again' });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(r.isError, `${tool} should be blocked`).toBe(true);
  expect(lastAudit(ctx.up.id)).toMatchObject({ toolName: tool, outcome: 'DENIED', decisionPath: 'snooze-deny', approvalId: null });
  expect((await fakeState(request, ctx.up.tenant)).calls[tool] ?? 0).toBe(before);
  expect((await pendingList(request, ctx.user)).filter((p) => p.upstream.id === ctx.up.id)).toEqual([]);
  return r.content[0].text as string;
}

/** Held (asks), then denied to end it. */
async function expectAsks(request: APIRequestContext, ctx: Ctx, token: string, tool: string) {
  const held = startCall(request, ctx.up.slug, token, tool, { item: 'q' });
  const p = await waitPending(request, ctx.up.id, tool, ctx.user);
  expect((await decide(request, p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
  expect((await held).isError).toBe(true);
}

async function setPolicy(request: APIRequestContext, ctx: Ctx, tool: string, policy: string) {
  const tools = (await (await request.get(`/api/upstreams/${ctx.up.id}/tools`, { headers: ctx.user })).json()).tools as { id: number; name: string }[];
  const t = tools.find((x) => x.name === tool)!;
  expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${t.id}`, { headers: ctx.user, data: { policy } })).status()).toBe(200);
}

test.describe('TC-122 API', () => {
  test('deny + 15 Min. + TOOL: Aufruf DENIED (+denied:page), DENY-Zeile für (User, Upstream, Client, TOOL, Tool); Text nennt Tool und Uhrzeit', async ({ request }) => {
    const ctx = await setup(request, 'dp122t');
    const { result, approvalId, response } = await decideHeld(request, ctx, ctx.A.token, 'add_item', { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'tool' });
    expect(response).toMatchObject({ state: 'denied' });
    expect(typeof response.snoozeUntil).toBe('string');
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('„add_item“');
    expect(text).toMatch(/bis \d\d\.\d\d\., \d\d:\d\d Uhr gesperrt/);
    const audit = dbAll('select * from AuditEntry where approvalId = ?', approvalId)[0];
    expect(audit).toMatchObject({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+denied:page' });
    const rows = snoozeRows(ctx.up.id);
    expect(rows).toHaveLength(1);
    const userId = dbAll('select id from User where username = ?', ctx.user['Remote-User'])[0].id;
    expect(rows[0]).toMatchObject({ effect: 'DENY', scope: 'TOOL', toolName: 'add_item', mcpClientId: ctx.A.id, userId });
    const minutes = (new Date(rows[0].until).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(new Date(rows[0].until).toISOString()).toBe(response.snoozeUntil);
  });

  test('deny + Heute + UPSTREAM: Zeile UPSTREAM ohne Toolname; Text nennt den Upstream', async ({ request }) => {
    const ctx = await setup(request, 'dp122u');
    const { result } = await decideHeld(request, ctx, ctx.A.token, 'add_item', { decision: 'deny', snoozeUntilMidnight: true, snoozeScope: 'upstream' });
    expect(result.content[0].text).toContain(`alle Tools von „${ctx.up.name}“`);
    expect(snoozeRows(ctx.up.id)).toEqual([expect.objectContaining({ effect: 'DENY', scope: 'UPSTREAM', toolName: null, mcpClientId: ctx.A.id })]);
  });

  test('400: READONLY mit deny, zu lang, ohne Umfang; 404 für fremde id; nichts gespeichert; deny ohne Pause wie bisher', async ({ request }) => {
    const ctx = await setup(request, 'dp122x');
    const other = freshUser('dp122o');
    const held = startCall(request, ctx.up.slug, ctx.A.token, 'list_items');
    const p = await waitPending(request, ctx.up.id, 'list_items', ctx.user);
    for (const bad of [
      { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'readonly' },
      { decision: 'deny', snoozeMinutes: 24 * 60 + 1, snoozeScope: 'tool' },
      { decision: 'deny', snoozeMinutes: 15 },
      { decision: 'deny', snoozeScope: 'tool' },
    ]) {
      const res = await decide(request, p.id, bad, ctx.user);
      expect(res.status(), JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    const readonlyRes = await decide(request, p.id, { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'readonly' }, ctx.user);
    expect((await readonlyRes.json()).error).toContain('Lesetools');
    expect((await decide(request, p.id, { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'tool' }, other)).status()).toBe(404);
    expect(snoozeRows(ctx.up.id)).toEqual([]);
    // Still held; a plain deny works as before and stores nothing.
    expect((await decide(request, p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    const r = await held;
    expect(r.content[0].text).toContain('abgelehnt');
    expect(snoozeRows(ctx.up.id)).toEqual([]);
    await expectAsks(request, ctx, ctx.A.token, 'list_items');
  });
});

test.describe('TC-123 Wirkung', () => {
  test('TOOL: gleiches Tool + Client sofort abgelehnt (kein Halt, kein Upstream), deutscher Text; anderes Tool und anderer Client fragen', async ({ request }) => {
    const ctx = await setup(request, 'dp123t');
    await decideHeld(request, ctx, ctx.A.token, 'add_item', { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'tool' });
    const text = await expectBlocked(request, ctx, ctx.A.token, 'add_item');
    expect(text).toMatch(/^\[xitl\] Verweigert: Der Nutzer hat „add_item“ für diesen Client bis \d\d\.\d\d\., \d\d:\d\d Uhr gesperrt/);
    // Retried twice more: still refused, still nothing forwarded.
    await expectBlocked(request, ctx, ctx.A.token, 'add_item');
    await expectAsks(request, ctx, ctx.A.token, 'list_items');
    await expectAsks(request, ctx, ctx.B.token, 'add_item');
    expect((await fakeState(request, ctx.up.tenant)).calls.add_item ?? 0).toBe(0);
  });

  test('UPSTREAM: jedes Tool für diesen Client gesperrt, auch mit expliziter ALLOW-Regel; anderer Client fragt', async ({ request }) => {
    const ctx = await setup(request, 'dp123u');
    await setPolicy(request, ctx, 'list_items', 'ALLOW');
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'list_items')).isError).toBeFalsy();
    await decideHeld(request, ctx, ctx.A.token, 'add_item', { decision: 'deny', snoozeMinutes: 60, snoozeScope: 'upstream' });
    for (const tool of ['add_item', 'list_items', 'delete_all']) {
      const text = await expectBlocked(request, ctx, ctx.A.token, tool);
      expect(text).toContain(`alle Tools von „${ctx.up.name}“ (auch „${tool}“)`);
    }
    // Client B is untouched: its ALLOW still forwards, its ASK still asks.
    expect((await callTool(request, ctx.up.slug, ctx.B.token, 'list_items')).isError).toBeFalsy();
    await expectAsks(request, ctx, ctx.B.token, 'add_item');
    // Denied tools stay listed (no list_changed, the error explains).
    const listed = await (await import('../support/upstream.js')).listTools(request, ctx.up.slug, ctx.A.token);
    expect(JSON.stringify(listed)).toContain('add_item');
  });

  test('Erlauben-Pause + Sperre gleichzeitig: Sperre gewinnt', async ({ request }) => {
    const ctx = await setup(request, 'dp123b');
    const allowed = await decideHeld(request, ctx, ctx.A.token, 'add_item', { decision: 'approve', snoozeMinutes: 60, snoozeScope: 'upstream' });
    expect(allowed.result.isError).toBeFalsy();
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'x' })).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze', outcome: 'FORWARDED' });
    // With the upstream-wide allow pause live, A's calls never reach a card,
    // so the deny pause is written the way the app writes it (createSnooze).
    const userId = dbAll('select id from User where username = ?', ctx.user['Remote-User'])[0].id;
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    const { dbRun } = await import('../support/db.js');
    dbRun(
      `insert into Snooze (userId, upstreamId, mcpClientId, scope, effect, toolName, until, createdAt) values (?, ?, ?, 'TOOL', 'DENY', 'add_item', ?, ?)`,
      userId,
      ctx.up.id,
      ctx.A.id,
      until.replace('Z', '+00:00'),
      new Date().toISOString().replace('Z', '+00:00'),
    );
    await expectBlocked(request, ctx, ctx.A.token, 'add_item');
    // Other tools of the upstream still go through the allow pause.
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'list_items')).isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'snooze' });
  });

  test('Eine Zeile mit unbekanntem effect sperrt (fail closed) und erscheint als Gesperrt', async ({ request }) => {
    const ctx = await setup(request, 'dp123g');
    const userId = dbAll('select id from User where username = ?', ctx.user['Remote-User'])[0].id;
    const { dbRun } = await import('../support/db.js');
    dbRun(
      `insert into Snooze (userId, upstreamId, mcpClientId, scope, effect, toolName, until, createdAt) values (?, ?, ?, 'TOOL', 'allow', 'add_item', ?, ?)`,
      userId,
      ctx.up.id,
      ctx.A.id,
      new Date(Date.now() + 15 * 60_000).toISOString().replace('Z', '+00:00'),
      new Date().toISOString().replace('Z', '+00:00'),
    );
    await expectBlocked(request, ctx, ctx.A.token, 'add_item');
    const list = await (await request.get(`/api/upstreams/${ctx.up.id}/snoozes`, { headers: ctx.user })).json();
    expect(list).toEqual([expect.objectContaining({ effect: 'DENY', toolName: 'add_item' })]);
  });
});

test.describe('TC-124 Pausen ansehen und aufheben', () => {
  test('Liste beider Wirkungen, nur die eigenen; Aufheben (fremd 404); danach fragt das Tool wieder', async ({ request }) => {
    const ctx = await setup(request, 'dp124');
    await decideHeld(request, ctx, ctx.A.token, 'list_items', { decision: 'approve', snoozeMinutes: 60, snoozeScope: 'tool' });
    await decideHeld(request, ctx, ctx.B.token, 'add_item', { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'tool' });
    // Another user's pause on their own upstream is invisible here.
    const other = await setup(request, 'dp124o');
    await decideHeld(request, other, other.A.token, 'add_item', { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'upstream' });

    const res = await request.get(`/api/upstreams/${ctx.up.id}/snoozes`, { headers: ctx.user });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    const list = (await res.json()) as { id: number; effect: string; scope: string; toolName: string | null; clientName: string; until: string }[];
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ effect: 'ALLOW', scope: 'TOOL', toolName: 'list_items', clientName: ctx.A.name }),
        expect.objectContaining({ effect: 'DENY', scope: 'TOOL', toolName: 'add_item', clientName: ctx.B.name }),
      ]),
    );
    for (const p of list) expect(Object.keys(p).sort()).toEqual(['clientName', 'createdAt', 'effect', 'id', 'mcpClientId', 'scope', 'toolName', 'until']);
    // Foreign: listing and lifting are 404, nothing changes.
    expect((await request.get(`/api/upstreams/${ctx.up.id}/snoozes`, { headers: other.user })).status()).toBe(404);
    const deny = list.find((p) => p.effect === 'DENY')!;
    expect((await request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${deny.id}`, { headers: other.user })).status()).toBe(404);
    const otherRow = snoozeRows(other.up.id)[0];
    expect((await request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${otherRow.id}`, { headers: ctx.user })).status()).toBe(404);
    expect((await request.delete(`/api/upstreams/${other.up.id}/snoozes/${otherRow.id}`, { headers: ctx.user })).status()).toBe(404);
    expect(snoozeRows(other.up.id)).toHaveLength(1);
    expect(snoozeRows(ctx.up.id)).toHaveLength(2);

    await expectBlocked(request, ctx, ctx.B.token, 'add_item');
    const lifted = await request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${deny.id}`, { headers: ctx.user });
    expect(lifted.status()).toBe(200);
    expect(((await lifted.json()) as unknown[]).length).toBe(1);
    expect((await request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${deny.id}`, { headers: ctx.user })).status()).toBe(404);
    await expectAsks(request, ctx, ctx.B.token, 'add_item');
  });
});

test.describe('TC-125 UI bei 390×844', () => {
  test('Karte und Detail: "Ablehnen und nicht mehr fragen bei …" mit Umfang und Dauer, Toast; Regeln: Aktive Pausen mit Chip, Umfang, Client, bis, Aufheben', async ({ page, request }) => {
    const ctx = await setup(request, 'dp125');
    await page.context().setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await expect(page.getByText('Keine offenen Freigaben.')).toBeVisible();

    // Card: TOOL scope (default), 15 Min.
    const h1 = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'x' });
    const card = page.locator('article.approval');
    await expect(card).toHaveCount(1);
    await expect(card.getByText('Ablehnen und nicht mehr fragen bei …')).toBeVisible();
    const scope = card.getByRole('radiogroup', { name: 'Umfang der Sperre' });
    await expect(scope.getByRole('radio')).toHaveCount(2);
    await expect(scope.getByLabel('dieses Tool')).toBeChecked();
    await expect(scope.getByLabel(`ganz ${ctx.up.name}`)).toBeVisible();
    const row = card.getByRole('group', { name: 'Ablehnen und sperren' });
    for (const n of ['15 Min.', '1 Std.', 'Heute']) await expect(row.getByText(n, { exact: true })).toBeVisible();
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc125-card.png'), fullPage: true });
    await row.getByRole('button', { name: 'Ablehnen, 15 Minuten sperren' }).click();
    await expect(page.getByText('Abgelehnt, 15 Minuten gesperrt: add_item')).toBeVisible();
    expect((await h1).isError).toBe(true);
    await expect(card).toHaveCount(0);
    expect(snoozeRows(ctx.up.id)).toEqual([expect.objectContaining({ effect: 'DENY', scope: 'TOOL', toolName: 'add_item' })]);

    // Detail page: UPSTREAM scope, Heute (client B).
    const h2 = startCall(request, ctx.up.slug, ctx.B.token, 'list_items');
    const p2 = await waitPending(request, ctx.up.id, 'list_items', ctx.user);
    await page.goto(`/#/freigabe/${p2.id}`);
    const detail = page.locator('article.approval');
    await detail.getByRole('radiogroup', { name: 'Umfang der Sperre' }).getByLabel(`ganz ${ctx.up.name}`).check();
    expect(await noHScroll(page)).toBe(false);
    await detail.getByRole('button', { name: 'Ablehnen, heute sperren' }).click();
    await expect(page.getByText(`Abgelehnt, heute gesperrt: alle Tools von ${ctx.up.name}`)).toBeVisible();
    expect((await h2).isError).toBe(true);

    // Plus an allow pause for the chip "Erlaubt" (client A, list_items).
    const h3 = startCall(request, ctx.up.slug, ctx.A.token, 'list_items');
    const p3 = await waitPending(request, ctx.up.id, 'list_items', ctx.user);
    expect((await decide(request, p3.id, { decision: 'approve', snoozeMinutes: 60, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    await h3;

    // Regeln: Aktive Pausen.
    await page.goto(`/#/regeln/${ctx.up.id}`);
    const section = page.getByRole('list', { name: 'Aktive Pausen' });
    await expect(section.locator('li')).toHaveCount(3);
    const toolDeny = section.locator('li', { hasText: ctx.A.name }).filter({ hasText: 'Gesperrt' });
    await expect(toolDeny).toContainText('add_item');
    await expect(toolDeny).toContainText(/bis \d\d:\d\d Uhr/);
    const upDeny = section.locator('li', { hasText: ctx.B.name });
    await expect(upDeny).toContainText('alle Tools');
    await expect(upDeny).toContainText('Gesperrt');
    await expect(section.locator('li', { hasText: 'Erlaubt' })).toContainText('list_items');
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc125-rules.png'), fullPage: true });

    await toolDeny.getByRole('button', { name: /^Pause aufheben/ }).click();
    await expect(page.getByText('Pause aufgehoben')).toBeVisible();
    await expect(section.locator('li')).toHaveCount(2);
    // A asks again for add_item.
    await expectAsks(request, ctx, ctx.A.token, 'add_item');
  });
});
