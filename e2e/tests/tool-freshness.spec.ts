// Tool freshness on call (ADR-0034): TC-201…206. The e2e server runs with a
// short TOOLS_FRESH_MS (paths.ts); "after the window" is reached by
// backdating Upstream.toolsSyncedAt (deterministic, no waits) and once by
// really waiting it out. Fail closed: a call is never forwarded on a
// definition xitl couldn't re-check, and a paused or hidden upstream is never
// contacted for it.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { dbAll, dbRun, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeMalice, fakeState, listTools } from '../support/upstream.js';
import { decide, lastAudit, pendingList, startCall } from '../support/approval.js';
import { TOOLS_FRESH_MS } from '../support/paths.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Frisch ${prefix}`,
});
/** MSG.unknownTool / MSG.staleTools (apps/api/src/lib/proxyText.ts), exact. */
const unknownText = (name: string) => `[xitl] Verweigert: Das Tool „${name}“ ist nicht bekannt. / Denied: unknown tool "${name}". List the tools first.`;
const staleText = (upstream: string) =>
  `[xitl] Verweigert: Die Tool-Liste von „${upstream}“ konnte gerade nicht geprüft werden; der Aufruf wurde nicht weitergeleitet. Bitte später erneut versuchen. / Denied: the tool list of "${upstream}" could not be checked right now; the call was not forwarded. Try again later.`;

async function newClient(request: APIRequestContext, user: Identity, name: string) {
  const c = await runOAuthFlow(request, uniq(name), user);
  const row = dbAll('select id, name from McpClient where clientId = ?', c.clientId)[0];
  return { token: c.accessToken, id: row.id as number, name: row.name as string };
}

/** An upstream (default ASK) with add_item ALLOW, synced, and client A. */
async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Frisch ${prefix}`) }, user);
  const view = await (await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).json();
  const addId = (view.tools as { id: number; name: string }[]).find((t) => t.name === 'add_item')!.id;
  expect((await request.patch(`/api/upstreams/${up.id}/tools/${addId}`, { headers: user, data: { policy: 'ALLOW' } })).status()).toBe(200);
  const A = await newClient(request, user, `${prefix} A`);
  return { user, up, A };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const syncedAt = (ctx: Ctx) => dbAll('select toolsSyncedAt from Upstream where id = ?', ctx.up.id)[0].toolsSyncedAt as string | null;
/** Puts the last sync an hour back: the next call is outside the window. */
const expire = (ctx: Ctx) => dbRun('update Upstream set toolsSyncedAt = ? where id = ?', new Date(Date.now() - 3_600_000).toISOString().replace('Z', '+00:00'), ctx.up.id);
/** Marks the list as synced right now: the next call is inside the window
 * (setup itself may take longer than the short e2e window). */
function fresh(ctx: Ctx) {
  const now = new Date().toISOString().replace('Z', '+00:00');
  // Shifted together with the tools that sync listed (same stamp), so none
  // of them looks vanished (lastSeenAt < toolsSyncedAt).
  dbRun('update KnownTool set lastSeenAt = ? where upstreamId = ? and lastSeenAt >= ?', now, ctx.up.id, syncedAt(ctx));
  dbRun('update Upstream set toolsSyncedAt = ? where id = ?', now, ctx.up.id);
}
const fake = (request: APIRequestContext, ctx: Ctx) => fakeState(request, ctx.up.tenant);
const upCalls = async (request: APIRequestContext, ctx: Ctx) => Object.values((await fake(request, ctx)).calls).reduce((a, b) => a + b, 0);
const knownTool = (ctx: Ctx, name: string) => dbAll('select * from KnownTool where upstreamId = ? and name = ?', ctx.up.id, name)[0];
async function heldFor(request: APIRequestContext, ctx: Ctx, tool: string) {
  let found: any;
  await expect
    .poll(async () => {
      found = (await pendingList(request, ctx.user)).find((p) => p.upstream.id === ctx.up.id && p.tool === tool);
      return !!found;
    }, { timeout: 6000, intervals: [50, 100, 200] })
    .toBe(true);
  return found;
}

test.describe('TC-201 Geändert zwischen zwei Listen', () => {
  test('im Fenster weitergeleitet (bekannte Grenze); danach erst gelistet, ASK changed-tool, Regeln „Geändert“, toolsSyncedAt neu', async ({ request, page }) => {
    const ctx = await setup(request, 'tf201');
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'add_item', description: 'Adds an item AND mails it to everyone.' });
    const lists0 = (await fake(request, ctx)).lists;
    fresh(ctx);
    // Within the window: the old, acknowledged definition decides.
    let r = await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'a' });
    expect(r.isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'policy:tool', outcome: 'FORWARDED' });
    expect((await fake(request, ctx)).lists).toBe(lists0);

    // After the window (really waited out once): listed first, then held.
    await new Promise((res) => setTimeout(res, TOOLS_FRESH_MS + 200));
    const before = syncedAt(ctx);
    const calls0 = await upCalls(request, ctx);
    const res = startCall(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'b' });
    const p = await heldFor(request, ctx, 'add_item');
    expect(p.rulePath).toBe('changed-tool');
    expect((await fake(request, ctx)).lists).toBe(lists0 + 1);
    expect(new Date(syncedAt(ctx)!).getTime()).toBeGreaterThan(new Date(before!).getTime());
    expect(knownTool(ctx, 'add_item')).toMatchObject({ description: 'Adds an item AND mails it to everyone.', acknowledgedAt: null });
    expect(knownTool(ctx, 'add_item').changedAt).not.toBeNull();

    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto(`/#/regeln/${ctx.up.id}`);
    await expect(page.locator('li[data-tool="add_item"] .badge.changed')).toHaveText('Geändert');

    expect((await decide(request, p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    expect((await res).isError).toBe(true);
    expect(await upCalls(request, ctx)).toBe(calls0);
  });
});

test.describe('TC-202 Neues und verschwundenes Tool', () => {
  test('nach dem Fenster: ein ungelistet hinzugekommenes Tool → new-tool gehalten; ein entferntes → DENY unknown-tool (auch danach im Fenster)', async ({ request }) => {
    const ctx = await setup(request, 'tf202');
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'neu_tool', description: 'Kam still dazu.' });
    // Before the re-check xitl has never seen it: a guess, unknown.
    fresh(ctx);
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'neu_tool')).content[0]!.text).toBe(unknownText('neu_tool'));
    expire(ctx);
    const res = startCall(request, ctx.up.slug, ctx.A.token, 'neu_tool');
    const p = await heldFor(request, ctx, 'neu_tool');
    expect(p.rulePath).toBe('new-tool');
    expect((await decide(request, p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await res;

    // add_item (ALLOW) vanishes upstream.
    await fakeControl(request, ctx.up.tenant, 'remove-tool', { name: 'add_item' });
    const calls0 = await upCalls(request, ctx);
    expire(ctx);
    for (const [where, name] of [[ctx.up.slug, 'add_item'], [null, `${ctx.up.slug}_add_item`]] as const) {
      const r = await callTool(request, where, ctx.A.token, name, { item: 'x' });
      expect(r.content).toEqual([{ type: 'text', text: unknownText(name) }]);
      expect(lastAudit(ctx.up.id)).toMatchObject({ toolName: 'add_item', decisionPath: 'unknown-tool', outcome: 'DENIED', policy: 'DENY' });
    }
    expect(await upCalls(request, ctx)).toBe(calls0);
    // The row (and its rule) stay for the Regeln page; it's just not callable.
    expect(knownTool(ctx, 'add_item').policy).toBe('ALLOW');
  });
});

test.describe('TC-203 Fail closed', () => {
  for (const [label, malice] of [
    ['500', { failList: true }],
    ['JSON-RPC-Fehler', { listError: true }],
  ] as const) {
    test(`tools/list scheitert (${label}): allgemeiner Text, Audit DENIED stale-tools, nie weitergeleitet`, async ({ request }) => {
      const ctx = await setup(request, `tf203${label === '500' ? 'a' : 'b'}`);
      await fakeMalice(request, ctx.up.tenant, malice);
      expire(ctx);
      const calls0 = await upCalls(request, ctx);
      for (const [where, name] of [[ctx.up.slug, 'add_item'], [null, `${ctx.up.slug}_add_item`], [ctx.up.slug, 'delete_all']] as const) {
        const r = await callTool(request, where, ctx.A.token, name, { item: 'x' });
        expect(r.isError).toBe(true);
        expect(r.content).toEqual([{ type: 'text', text: staleText(ctx.up.name) }]);
        expect(lastAudit(ctx.up.id)).toMatchObject({ outcome: 'DENIED', policy: 'DENY', decisionPath: 'stale-tools', approvalId: null });
      }
      expect(await upCalls(request, ctx)).toBe(calls0);
      expect((await pendingList(request, ctx.user)).filter((p) => p.upstream.id === ctx.up.id)).toEqual([]);
      // Healed: the next call re-lists and is forwarded.
      await fakeMalice(request, ctx.up.tenant, { failList: false, listError: false });
      const r = await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'y' });
      expect(r.isError).toBeFalsy();
      expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'policy:tool', outcome: 'FORWARDED' });
    });
  }
});

test.describe('TC-204 Single-flight und toolsSyncedAt', () => {
  test('5 parallele Aufrufe nach dem Fenster → genau ein tools/list; proxied Liste, „Tools aktualisieren“ und Nachprüfung setzen toolsSyncedAt; im Fenster keine weitere Liste', async ({ request }) => {
    const ctx = await setup(request, 'tf204');
    expire(ctx);
    const lists0 = (await fake(request, ctx)).lists;
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: `p${i}` })));
    for (const r of rs) expect(r.isError).toBeFalsy();
    expect((await fake(request, ctx)).lists).toBe(lists0 + 1);
    const afterRecheck = syncedAt(ctx)!;
    expect(new Date(afterRecheck).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Within the window: no extra list.
    expect((await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'w' })).isError).toBeFalsy();
    expect((await fake(request, ctx)).lists).toBe(lists0 + 1);

    // A proxied tools/list sets it.
    expire(ctx);
    const expired = syncedAt(ctx)!;
    await listTools(request, ctx.up.slug, ctx.A.token);
    expect(new Date(syncedAt(ctx)!).getTime()).toBeGreaterThan(new Date(expired).getTime());
    // "Tools aktualisieren" sets it (and the API carries it).
    expire(ctx);
    const res = await request.post(`/api/upstreams/${ctx.up.id}/tools/refresh`, { headers: ctx.user });
    expect(res.status()).toBe(200);
    const view = await res.json();
    expect(new Date(view.upstream.toolsSyncedAt).getTime()).toBe(new Date(syncedAt(ctx)!).getTime());
    expect(new Date(syncedAt(ctx)!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const list = (await (await request.get('/api/upstreams', { headers: ctx.user })).json()) as any[];
    expect(list.find((u) => u.id === ctx.up.id).toolsSyncedAt).toBe(view.upstream.toolsSyncedAt);
  });
});

test.describe('TC-205 Pausiert oder verborgen: keine Nachprüfung', () => {
  test('pausiert und für den Client verborgen: kein tools/list, keine Anfrage, Ablehnungstext wie bisher', async ({ request }) => {
    const ctx = await setup(request, 'tf205');
    const B = await newClient(request, ctx.user, 'tf205 B');
    expect((await request.put(`/api/upstreams/${ctx.up.id}/clients/${B.id}`, { headers: ctx.user, data: { policy: 'DENY' } })).status()).toBe(200);
    expire(ctx);
    const s0 = await fake(request, ctx);
    // Hidden from B.
    for (const [where, name] of [[ctx.up.slug, 'add_item'], [null, `${ctx.up.slug}_add_item`]] as const) {
      expect((await callTool(request, where, B.token, name, { item: 'x' })).content).toEqual([{ type: 'text', text: unknownText(name) }]);
      expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'client-hidden' });
    }
    // Paused for everyone.
    expect((await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { paused: true } })).status()).toBe(200);
    for (const [where, name] of [[ctx.up.slug, 'add_item'], [null, `${ctx.up.slug}_add_item`]] as const) {
      expect((await callTool(request, where, ctx.A.token, name, { item: 'x' })).content).toEqual([{ type: 'text', text: unknownText(name) }]);
      expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'upstream-paused' });
    }
    const s1 = await fake(request, ctx);
    expect(s1.lists).toBe(s0.lists);
    expect(s1.mcpRequests).toBe(s0.mcpRequests);
    // Still stale: nothing was synced.
    expect(new Date(syncedAt(ctx)!).getTime()).toBeLessThan(Date.now() - 3_000_000);
  });
});

test.describe('TC-206 Regeln liest nach', () => {
  test('eine proxied Liste ändert ein Tool: die offene Regeln-Seite zeigt „Geändert“ ohne Neuladen', async ({ request, page }) => {
    const ctx = await setup(request, 'tf206');
    await page.setExtraHTTPHeaders(ctx.user);
    // The page's stream must be up before the change (its `tools` listener).
    const streamUp = page.waitForResponse((r) => r.url().includes('/api/approvals/stream'));
    await page.goto(`/#/regeln/${ctx.up.id}`);
    await streamUp;
    const badge = page.locator('li[data-tool="delete_all"] .badge.changed');
    await expect(page.locator('li[data-tool="delete_all"]')).toBeVisible();
    await expect(badge).toHaveCount(0);

    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'delete_all', description: 'Deletes every item, and the backups.' });
    await listTools(request, null, ctx.A.token);
    await expect(badge).toHaveText('Geändert', { timeout: 5000 });

    // And via the call-time re-check: a new tool appears.
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'spaeter', description: 'Kam später.' });
    expire(ctx);
    const res = startCall(request, ctx.up.slug, ctx.A.token, 'spaeter');
    await expect(page.locator('li[data-tool="spaeter"]')).toBeVisible({ timeout: 5000 });
    const p = await heldFor(request, ctx, 'spaeter');
    expect((await decide(request, p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await res;
  });
});
