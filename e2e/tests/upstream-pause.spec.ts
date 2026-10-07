// Pause an upstream (ADR-0033): TC-195…200. The precedence (TC-194) is a unit
// test in apps/api/src/lib/policy.test.ts. Fresh users per case; A and B are
// OAuth clients (reach every upstream), T an all-upstreams token, S a token of
// only this upstream. Fail closed: a paused upstream must never be listed,
// described, contacted or forwarded to, and its refusal must read exactly
// like an unknown tool.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, dbRun, uniq } from '../support/db.js';
import { INITIALIZE, runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeMalice, fakeState, listTools, mcp } from '../support/upstream.js';
import { decide, lastAudit, openStream, pendingList, startCall } from '../support/approval.js';
import { firstPushes, settle, subscribe } from '../support/push.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Pausiert ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const PREFIX_LINE = 'Über xitl vermittelt: manche Tools brauchen eine Freigabe. / Proxied by xitl: some tools need approval.';
/** MSG.unknownTool (apps/api/src/lib/proxyText.ts), the exact text. */
const unknownText = (name: string) => `[xitl] Verweigert: Das Tool „${name}“ ist nicht bekannt. / Denied: unknown tool "${name}". List the tools first.`;

async function newClient(request: APIRequestContext, user: Identity, name: string) {
  const c = await runOAuthFlow(request, uniq(name), user);
  const row = dbAll('select id, name from McpClient where clientId = ?', c.clientId)[0];
  return { token: c.accessToken, id: row.id as number, name: row.name as string };
}

async function setup(request: APIRequestContext, prefix: string, defaultPolicy = 'ALLOW') {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy, name: uniq(`Upstream ${prefix}`), description: `Beschreibung ${prefix} ${Date.now()}` }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await newClient(request, user, `${prefix} A`);
  const B = await newClient(request, user, `${prefix} B`);
  return { user, up, A, B };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const pause = (request: APIRequestContext, ctx: Ctx, paused: boolean, extra: Record<string, unknown> = {}, user = ctx.user) =>
  request.patch(`/api/upstreams/${ctx.up.id}`, { headers: user, data: { paused, ...extra } });
async function setPaused(request: APIRequestContext, ctx: Ctx, paused: boolean) {
  const res = await pause(request, ctx, paused);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const pausedAt = (id: number) => dbAll('select pausedAt from Upstream where id = ?', id)[0].pausedAt as string | null;
/** A DateTime as Prisma stores it in SQLite. */
const dbTime = (d: Date) => d.toISOString().replace('Z', '+00:00');
const fake = (request: APIRequestContext, ctx: Ctx) => fakeState(request, ctx.up.tenant);
const upCalls = async (request: APIRequestContext, ctx: Ctx) => Object.values((await fake(request, ctx)).calls).reduce((a, b) => a + b, 0);
const ownTools = (tools: { name: string }[], slug: string) => tools.filter((t) => t.name.startsWith(`${slug}_`)).map((t) => t.name).sort();
async function toolId(request: APIRequestContext, ctx: Ctx, name: string) {
  const v = await (await request.get(`/api/upstreams/${ctx.up.id}/tools`, { headers: ctx.user })).json();
  return (v.tools as { id: number; name: string }[]).find((t) => t.name === name)!.id;
}
async function setTool(request: APIRequestContext, ctx: Ctx, name: string, policy: string | null) {
  expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${await toolId(request, ctx, name)}`, { headers: ctx.user, data: { policy } })).status()).toBe(200);
}
async function waitHeldFor(request: APIRequestContext, user: Identity, pred: (p: any) => boolean, known: string[] = []) {
  let found: any;
  await expect
    .poll(async () => {
      found = (await pendingList(request, user)).find((p) => pred(p) && !known.includes(p.id));
      return !!found;
    }, { timeout: 6000, intervals: [50, 100, 200] })
    .toBe(true);
  return found;
}

test.describe('TC-195 API', () => {
  test('PATCH {paused} setzt/löscht pausedAt (erste Pause bleibt), mit anderen Feldern; 400 deutsch; fremd 404; ohne Remote-User 401; Liste trägt pausedAt', async ({ request }) => {
    const ctx = await setup(request, 'up195');
    const stranger = freshUser('up195x');
    expect(pausedAt(ctx.up.id)).toBeNull();

    let body = await setPaused(request, ctx, true);
    expect(typeof body.pausedAt).toBe('string');
    const first = pausedAt(ctx.up.id);
    expect(first).not.toBeNull();
    await settle(30);
    // Repeat keeps the first time.
    body = await setPaused(request, ctx, true);
    expect(pausedAt(ctx.up.id)).toBe(first);
    expect(new Date(body.pausedAt).getTime()).toBe(new Date(first!).getTime());
    // The list carries it.
    const list = (await (await request.get('/api/upstreams', { headers: ctx.user })).json()) as any[];
    expect(list.find((u) => u.id === ctx.up.id).pausedAt).toBe(body.pausedAt);

    // Combined with other fields.
    const renamed = uniq('Umbenannt');
    let res = await pause(request, ctx, false, { name: renamed, defaultPolicy: 'ASK' });
    expect(res.status()).toBe(200);
    body = await res.json();
    expect(body).toMatchObject({ pausedAt: null, name: renamed, defaultPolicy: 'ASK' });
    expect(pausedAt(ctx.up.id)).toBeNull();
    res = await pause(request, ctx, true, { description: 'neu' });
    expect((await res.json()).description).toBe('neu');
    expect(pausedAt(ctx.up.id)).not.toBeNull();

    // Not a boolean: 400, German, unchanged.
    for (const bad of ['true', 1, null, 'ja', {}]) {
      const r = await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { paused: bad } });
      expect(r.status(), JSON.stringify(bad)).toBe(400);
      expect((await r.json()).error).toBe('paused muss true oder false sein.');
    }
    expect(pausedAt(ctx.up.id)).not.toBeNull();

    // Another user's upstream: 404, unchanged (both directions).
    res = await pause(request, ctx, false, {}, stranger);
    expect(res.status()).toBe(404);
    expect(pausedAt(ctx.up.id)).not.toBeNull();
    // Without Remote-User: 401.
    res = await request.patch(`/api/upstreams/${ctx.up.id}`, { data: { paused: false } });
    expect(res.status()).toBe(401);
    expect(pausedAt(ctx.up.id)).not.toBeNull();

    // Connecting / refreshing a paused upstream is refused without contact.
    const before = (await fake(request, ctx)).mcpRequests;
    res = await request.post(`/api/upstreams/${ctx.up.id}/tools/refresh`, { headers: ctx.user });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe('Der Upstream ist pausiert. Setze ihn erst fort.');
    res = await request.post(`/api/upstreams/${ctx.up.id}/connect`, { headers: ctx.user });
    expect(res.status()).toBe(409);
    expect((await fake(request, ctx)).mcpRequests).toBe(before);

    await setPaused(request, ctx, false);
    expect(pausedAt(ctx.up.id)).toBeNull();
  });
});

test.describe('TC-196 Verborgen und nie kontaktiert', () => {
  test('pausiert: keine Tools für OAuth, Alle-Token und Einzel-Token; Anweisungen ohne Abschnitt; der Fake sieht null Anfragen, auch kaputt kein Push', async ({ request }) => {
    const ctx = await setup(request, 'up196');
    const slug = ctx.up.slug;
    const own = `Eigene Anweisungen ${ctx.up.tenant}: geheim.`;
    await fakeControl(request, ctx.up.tenant, 'config', { instructions: own });
    const T = (await (await request.post('/api/mcp/tokens', { headers: ctx.user, data: { name: uniq('T') } })).json()).token as string;
    const S = (await (await request.post(`/api/upstreams/${ctx.up.id}/tokens`, { headers: ctx.user, data: { name: uniq('S') } })).json()).token as string;
    const other = await connectedUpstream(request, 'up196b', { defaultPolicy: 'ALLOW', name: uniq('Andere') }, ctx.user);
    const all = [`${slug}_add_item`, `${slug}_delete_all`, `${slug}_list_items`];
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual(all);
    const up = dbAll('select name, slug, description from Upstream where id = ?', ctx.up.id)[0];
    const initText = async (s: string | null, token: string) => (await mcp(request, s, token, 'initialize', INITIALIZE.params)).result.instructions as string;
    const leaks = (text: string) => [up.name, `${up.slug}_`, own, up.description].filter((x) => text.includes(x));
    expect(leaks(await initText(null, ctx.A.token))).toHaveLength(4);

    await setPaused(request, ctx, true);
    const endpoint = await subscribe(request, ctx.user);
    const before = (await fake(request, ctx)).mcpRequests;
    // tools/list: nothing of it, on every endpoint and for every client kind.
    for (const token of [ctx.A.token, ctx.B.token, T]) {
      const tools = await listTools(request, null, token);
      expect(ownTools(tools, slug)).toEqual([]);
      expect(tools.some((t) => t.name.startsWith(`${other.slug}_`))).toBe(true);
      expect(await listTools(request, slug, token)).toEqual([]);
    }
    expect(await listTools(request, slug, S)).toEqual([]);
    // initialize: no section / state line; only xitl's line on /mcp/<slug>.
    for (const token of [ctx.A.token, T]) {
      const text = await initText(null, token);
      expect(leaks(text)).toEqual([]);
      expect(text.startsWith(PREFIX_LINE)).toBe(true);
      expect(await initText(slug, token)).toBe(PREFIX_LINE);
    }
    expect(await initText(slug, S)).toBe(PREFIX_LINE);
    expect((await fake(request, ctx)).mcpRequests).toBe(before);

    // Broken meanwhile: still nothing contacted, no failure state, no push, no Störung card.
    await fakeMalice(request, ctx.up.tenant, { failMcp: true });
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual([]);
    const text = await initText(null, ctx.A.token);
    expect(text).not.toContain('nicht erreichbar');
    expect(leaks(text)).toEqual([]);
    await callTool(request, slug, ctx.A.token, 'list_items');
    await settle();
    expect((await fake(request, ctx)).mcpRequests).toBe(before);
    expect(dbAll('select lastFailureAt from Upstream where id = ?', ctx.up.id)[0].lastFailureAt).toBeNull();
    expect(firstPushes(endpoint).filter((p) => p.payload.type === 'upstream')).toEqual([]);
    expect(((await (await request.get('/api/upstreams/faults', { headers: ctx.user })).json()) as any[]).map((f) => f.id)).not.toContain(ctx.up.id);
    await fakeMalice(request, ctx.up.tenant, { failMcp: false });
  });

  test('ein schon gestörter Upstream verliert beim Pausieren seine Störungskarte', async ({ request }) => {
    const ctx = await setup(request, 'up196f');
    await fakeMalice(request, ctx.up.tenant, { failMcp: true });
    expect((await request.post(`/api/upstreams/${ctx.up.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(502);
    const faults = async () => ((await (await request.get('/api/upstreams/faults', { headers: ctx.user })).json()) as any[]).map((f) => f.id);
    expect(await faults()).toContain(ctx.up.id);
    const stream = await openStream(ctx.user);
    await setPaused(request, ctx, true);
    expect(await faults()).not.toContain(ctx.up.id);
    await expect.poll(() => stream.events.filter((e) => e.event === 'upstreams').at(-1)?.data.map((f: any) => f.id)).toEqual([]);
    await stream.close();
    await fakeMalice(request, ctx.up.tenant, { failMcp: false });
  });
});

test.describe('TC-197 Aufrufe', () => {
  test('beide Endpunkte: sofort der Unbekannt-Text (byte-gleich), Audit upstream-paused, kein Halt, kein Push, nichts kontaktiert; auch mit Tool-ALLOW und Zeitfreigabe', async ({ request, page }) => {
    const ctx = await setup(request, 'up197', 'ASK');
    const slug = ctx.up.slug;
    await setTool(request, ctx, 'list_items', 'ALLOW');
    // A live Zeitfreigabe for A on add_item, granted before pausing.
    const held = startCall(request, slug, ctx.A.token, 'add_item', { item: 'z' });
    const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    expect((await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    expect((await held).isError).toBeFalsy();

    await setPaused(request, ctx, true);
    const endpoint = await subscribe(request, ctx.user);
    const reqBefore = (await fake(request, ctx)).mcpRequests;
    const callsBefore = await upCalls(request, ctx);
    const auditsBefore = dbAll('select count(*) as n from AuditEntry where upstreamId = ?', ctx.up.id)[0].n as number;
    for (const tool of ['list_items', 'add_item', 'delete_all']) {
      for (const [where, name] of [[null, `${slug}_${tool}`], [slug, tool]] as const) {
        const t0 = Date.now();
        const r = await callTool(request, where, ctx.A.token, name, { item: 'x' });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r.isError, `${where} ${name}`).toBe(true);
        expect(r.content).toEqual([{ type: 'text', text: unknownText(name) }]);
        expect(lastAudit(ctx.up.id), `${where} ${name}`).toMatchObject({
          toolName: tool,
          mcpClientId: ctx.A.id,
          outcome: 'DENIED',
          policy: 'DENY',
          decisionPath: 'upstream-paused',
          approvalId: null,
          intentStatus: 'SKIPPED',
          endpoint: where === null ? '/mcp' : `/mcp/${slug}`,
        });
      }
    }
    // A name it never listed is an unknown tool (same text either way).
    const r = await callTool(request, slug, ctx.B.token, 'gibt_es_nicht');
    expect(r.content[0]!.text).toBe(unknownText('gibt_es_nicht'));
    expect(dbAll('select count(*) as n from AuditEntry where upstreamId = ?', ctx.up.id)[0].n).toBe(auditsBefore + 7);
    expect(await upCalls(request, ctx)).toBe(callsBefore);
    expect((await fake(request, ctx)).mcpRequests).toBe(reqBefore);
    expect((await pendingList(request, ctx.user)).filter((x) => x.upstream.id === ctx.up.id)).toEqual([]);
    await settle();
    expect(firstPushes(endpoint)).toEqual([]);

    // Verlauf tells the truth.
    const row = dbAll("select id from AuditEntry where upstreamId = ? and decisionPath = 'upstream-paused' order by id desc limit 1", ctx.up.id)[0];
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto(`/#/verlauf/${row.id}`);
    await expect(page.getByText('Upstream pausiert')).toBeVisible();
    expect(await noHScroll(page)).toBe(false);
  });
});

test.describe('TC-198 Gehaltene Aufrufe', () => {
  test('Pausieren beendet gehaltene Aufrufe zweier Clients am Upstream (+denied:upstream-paused, Unbekannt-Text, Karten weg); anderer Upstream bleibt', async ({ request }) => {
    const ctx = await setup(request, 'up198', 'ASK');
    const slug = ctx.up.slug;
    const up2 = await connectedUpstream(request, 'up198b', { defaultPolicy: 'ASK', name: uniq('Zweiter') }, ctx.user);
    expect((await request.post(`/api/upstreams/${up2.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(200);
    const stream = await openStream(ctx.user);
    const known: string[] = [];
    const hold = async (s: string | null, token: string, name: string, pred: (p: any) => boolean) => {
      const res = startCall(request, s as string, token, name, { item: 'h' });
      const p = await waitHeldFor(request, ctx.user, pred, known);
      known.push(p.id);
      return { res, id: p.id as string };
    };
    const a1 = await hold(slug, ctx.A.token, 'add_item', (p) => p.upstream.id === ctx.up.id && p.tool === 'add_item');
    const b1 = await hold(null, ctx.B.token, `${slug}_list_items`, (p) => p.upstream.id === ctx.up.id && p.tool === 'list_items');
    const a2 = await hold(up2.slug, ctx.A.token, 'add_item', (p) => p.upstream.id === up2.id);

    const callsBefore = await upCalls(request, ctx);
    await setPaused(request, ctx, true);
    expect((await a1.res).content).toEqual([{ type: 'text', text: unknownText('add_item') }]);
    expect((await b1.res).content).toEqual([{ type: 'text', text: unknownText(`${slug}_list_items`) }]);
    for (const id of [a1.id, b1.id]) {
      expect(dbAll('select outcome, decisionPath from AuditEntry where approvalId = ?', id)[0]).toEqual({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+denied:upstream-paused' });
    }
    expect(await upCalls(request, ctx)).toBe(callsBefore);
    expect((await pendingList(request, ctx.user)).map((p) => p.id)).toEqual([a2.id]);
    await expect.poll(() => stream.events.filter((e) => e.event === 'resolved').map((e) => e.data.id).sort()).toEqual([a1.id, b1.id].sort());
    await stream.close();
    expect((await decide(request, a2.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await a2.res;
  });

  test('eine Freigabe nach dem Pausieren leitet nicht weiter (Nachprüfung im Proxy)', async ({ request }) => {
    const ctx = await setup(request, 'up198r', 'ASK');
    const res = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'r' });
    const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    // Paused behind the hub's back (as if it happened between evaluation and hold).
    dbRun('update Upstream set pausedAt = ? where id = ?', dbTime(new Date()), ctx.up.id);
    const callsBefore = await upCalls(request, ctx);
    expect((await decide(request, p.id, { decision: 'approve' }, ctx.user)).status()).toBe(200);
    expect((await res).content).toEqual([{ type: 'text', text: unknownText('add_item') }]);
    expect(dbAll('select outcome, decisionPath from AuditEntry where approvalId = ?', p.id)[0]).toEqual({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+denied:upstream-paused' });
    expect(await upCalls(request, ctx)).toBe(callsBefore);
    await setPaused(request, ctx, false);
  });
});

test.describe('TC-199 Fortsetzen', () => {
  test('alles wie vorher: Tools gelistet, Regeln, Client-Voreinst. und Zeitfreigaben unverändert, Aufrufe wie vor dem Pausieren', async ({ request }) => {
    const ctx = await setup(request, 'up199', 'ASK');
    const slug = ctx.up.slug;
    await setTool(request, ctx, 'list_items', 'ALLOW');
    expect((await request.put(`/api/upstreams/${ctx.up.id}/clients/${ctx.B.id}`, { headers: ctx.user, data: { policy: 'DENY' } })).status()).toBe(200);
    // Zeitfreigabe for A on add_item.
    const held = startCall(request, slug, ctx.A.token, 'add_item', { item: 'z' });
    const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    expect((await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    await held;
    const snap = () => ({
      tools: dbAll('select name, policy, acknowledgedAt, changedAt from KnownTool where upstreamId = ? order by name', ctx.up.id),
      defaults: dbAll('select mcpClientId, policy from ClientUpstreamPolicy where upstreamId = ?', ctx.up.id),
      snoozes: dbAll('select id, toolName, until from Snooze where upstreamId = ?', ctx.up.id),
      up: dbAll('select defaultPolicy, status, accessToken is not null as tok from Upstream where id = ?', ctx.up.id),
    });
    const listedA = ownTools(await listTools(request, null, ctx.A.token), slug);
    const before = snap();

    await setPaused(request, ctx, true);
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual([]);
    await setPaused(request, ctx, false);
    expect(snap()).toEqual(before);
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual(listedA);
    expect(ownTools(await listTools(request, null, ctx.B.token), slug)).toEqual([]);
    // Calls as before: rule ALLOW forwarded, Zeitfreigabe forwarded, B hidden.
    let r = await callTool(request, slug, ctx.A.token, 'list_items');
    expect(r.isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'policy:tool', outcome: 'FORWARDED' });
    r = await callTool(request, null, ctx.A.token, `${slug}_add_item`, { item: 'q' });
    expect(r.isError).toBeFalsy();
    expect(lastAudit(ctx.up.id).decisionPath).toMatch(/^snooze/);
    r = await callTool(request, slug, ctx.B.token, 'list_items');
    expect(r.content[0]!.text).toBe(unknownText('list_items'));
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'client-hidden' });
  });
});

test.describe('TC-200 UI', () => {
  test('Einstellungen und Regeln: Pausieren/Fortsetzen, Chip; „Läuft gerade“ mit Fortsetzen, live; „Alle beenden“ lässt ihn pausiert; 390×844', async ({ request, page }) => {
    const ctx = await setup(request, 'ui200', 'ASK');
    const stranger = freshUser('ui200x');
    const strangerUp = await connectedUpstream(request, 'ui200s', { defaultPolicy: 'ASK', name: uniq('Fremd pausiert') }, stranger);
    expect((await request.patch(`/api/upstreams/${strangerUp.id}`, { headers: stranger, data: { paused: true } })).status()).toBe(200);
    await page.setExtraHTTPHeaders(ctx.user);
    const item = () => page.locator(`li.item[data-slug="${ctx.up.slug}"]`);

    // Einstellungen: switch "Aktiv" off → chip, no fix button; tap target ≥ 44 px.
    await page.goto('/#/einstellungen');
    const sw = item().getByRole('switch', { name: `Aktiv: ${ctx.up.name}` });
    await expect(sw).toBeChecked();
    expect((await sw.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await sw.click();
    await expect(item().getByTestId('upstream-paused')).toHaveText('pausiert');
    await expect(sw).not.toBeChecked();
    expect(pausedAt(ctx.up.id)).not.toBeNull();
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc200-einstellungen.png'), fullPage: true });
    await sw.click();
    await expect(item().getByTestId('upstream-paused')).toHaveCount(0);
    await expect(sw).toBeChecked();
    expect(pausedAt(ctx.up.id)).toBeNull();

    // The upstream's page: the same switch in the card on top, with the note.
    await page.goto(`/#/regeln/${ctx.up.id}`);
    const dsw = page.getByRole('switch', { name: `Aktiv: ${ctx.up.name}` });
    await dsw.click();
    await expect(page.getByTestId('rules-paused')).toHaveText('pausiert');
    await expect(page.getByTestId('active-note')).toContainText('Kein Client sieht seine Tools');
    expect(pausedAt(ctx.up.id)).not.toBeNull();
    expect((await dsw.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc200-regeln.png'), fullPage: true });

    // Läuft gerade: listed with "seit HH:MM"; a Zeitfreigabe too, for "Alle beenden".
    await setPaused(request, ctx, false);
    const held = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'z' });
    const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    expect((await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    await held;
    await page.goto('/');
    await expect(page.getByTestId('running-summary')).toContainText('1 Zeitfreigabe');
    // Live: pausing elsewhere shows up without a reload (`running` event).
    await setPaused(request, ctx, true);
    await expect(page.getByTestId('running-summary')).toContainText('1 Upstream pausiert');
    await expect(page.getByTestId('running-summary')).not.toContainText('Fremd');
    const summary = page.getByTestId('running-summary');
    if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
    const row = page.locator(`[data-running-upstream="${ctx.up.id}"]`);
    await expect(row).toContainText('Upstream pausiert');
    await expect(row).toContainText(ctx.up.name);
    await expect(row.locator('.running-meta')).toHaveText(/^seit \d\d:\d\d$/);
    await expect(page.locator(`[data-running-upstream="${strangerUp.id}"]`)).toHaveCount(0);
    expect(((await (await request.get('/api/running', { headers: ctx.user })).json()).pausedUpstreams as any[]).map((u) => u.id)).toEqual([ctx.up.id]);
    const rowBtn = row.getByRole('button', { name: `Upstream fortsetzen: ${ctx.up.name}` });
    expect((await rowBtn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc200-laeuft.png'), fullPage: true });

    // "Alle beenden" ends the Zeitfreigabe, the upstream stays paused.
    await page.getByRole('button', { name: 'Alle beenden' }).click();
    await expect(page.getByRole('dialog')).toContainText('Pausierte Upstreams bleiben pausiert');
    await page.getByRole('dialog').getByRole('button', { name: 'Alle beenden' }).click();
    await expect(page.getByTestId('running-summary')).toHaveText(/Läuft gerade: 1 Upstream pausiert/);
    expect(pausedAt(ctx.up.id)).not.toBeNull();
    expect(dbAll('select count(*) as n from Snooze where upstreamId = ?', ctx.up.id)[0].n).toBe(0);

    // Fortsetzen from the overview.
    await rowBtn.click();
    await expect(page.getByTestId('running')).toHaveCount(0);
    expect(pausedAt(ctx.up.id)).toBeNull();
    // The stranger's upstream stays paused and was never shown.
    expect(pausedAt(strangerUp.id)).not.toBeNull();
  });
});
