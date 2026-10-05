// A failing upstream is visible on `/mcp` and in the app (ADR-0022): TC-90…93.
//
// One identity per case (ST_API, ST_LIST, ST_INIT, ST_UI, see support/db.ts):
// exact tool lists and instruction sections are asserted, and a connected
// upstream must never exist for anna (TC-16). The fake upstream is broken with
// the malice modes `failMcp` (500) / `redirectMcp` and healed by switching them
// off again; "needs reconnect" is an expired access token with a rejected refresh.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ST_API, ST_INIT, ST_LIST, ST_UI, createUpstream, dbAll, uniq } from '../support/db.js';
import { INITIALIZE, LIST, parseRpc, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { FAKE_HEADER_SECRET } from '../support/paths.js';
import { callTool, connectedUpstream, fakeControl, fakeMalice, fakeMcpUrl, fakeState, listTools, mcp, newTenant } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

type User = Record<string, string>;
type Up = Awaited<ReturnType<typeof connectedUpstream>>;

const uid = (u: User) => dbAll('select id from User where username = ?', u['Remote-User'])[0].id as number;
const auditCount = (u: User) => dbAll('select count(*) c from AuditEntry where userId = ?', uid(u))[0].c as number;
const sections = (instructions: string) => instructions.split('\n').filter((l) => l.startsWith('## '));

async function upstreamRow(request: APIRequestContext, id: number, user: User) {
  const res = await request.get('/api/upstreams', { headers: user });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: number; status: string; lastFailureAt: string | null }[]).find((u) => u.id === id)!;
}
const refresh = (request: APIRequestContext, id: number, user: User) => request.post(`/api/upstreams/${id}/tools/refresh`, { headers: user });

/** A connected upstream with its tools known; `list_items` ALLOWed. */
async function upstream(request: APIRequestContext, prefix: string, user: User): Promise<Up> {
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ALLOW', name: uniq(`Up ${prefix}`) }, user);
  expect((await refresh(request, up.id, user)).status()).toBe(200);
  const view = (await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: user })).json()) as { tools: { id: number; name: string }[] };
  const tool = view.tools.find((t) => t.name === 'list_items')!;
  expect((await request.patch(`/api/upstreams/${up.id}/tools/${tool.id}`, { headers: user, data: { policy: 'ALLOW' } })).status()).toBe(200);
  return up;
}
/** Access token dead and the refresh rejected: the next contact needs a reconnect. */
async function breakLogin(request: APIRequestContext, up: Up) {
  await fakeControl(request, up.tenant, 'expire-access');
  await fakeControl(request, up.tenant, 'config', { rejectRefresh: true });
}

test('TC-90 Zustand: Fehlkontakt setzt lastFailureAt, Erfolg löscht es, Verbindungszustände lassen es unberührt, isError zählt als Erfolg', async ({ request }) => {
  const user = ST_API;
  const a = await upstream(request, 'tc90a', user);
  expect((await upstreamRow(request, a.id, user)).lastFailureAt).toBeNull();

  // 500 -> set (ISO), the API says nothing else about the failure
  await fakeMalice(request, a.tenant, { failMcp: true });
  const failed = await refresh(request, a.id, user);
  expect(failed.status()).toBe(502);
  expect(await failed.json()).toEqual({ error: 'Der Upstream ist gerade nicht erreichbar.' });
  expect((await upstreamRow(request, a.id, user)).lastFailureAt).toMatch(/^\d{4}-\d\d-\d\dT/);

  // success -> cleared
  await fakeMalice(request, a.tenant, { failMcp: false });
  expect((await refresh(request, a.id, user)).status()).toBe(200);
  expect((await upstreamRow(request, a.id, user)).lastFailureAt).toBeNull();

  // redirect (never followed) fails the same way
  await fakeMalice(request, a.tenant, { redirectMcp: true });
  expect((await refresh(request, a.id, user)).status()).toBe(502);
  expect((await upstreamRow(request, a.id, user)).lastFailureAt).not.toBeNull();

  // a tool call answered with isError counts as success
  await fakeMalice(request, a.tenant, { redirectMcp: false, echoInErrorResult: true });
  const { accessToken: token } = await runOAuthFlow(request, uniq('Client tc90'), user);
  const res = await callTool(request, null, token, `${a.slug}_list_items`);
  expect(res.isError).toBe(true);
  expect((await upstreamRow(request, a.id, user)).lastFailureAt).toBeNull();
  await fakeMalice(request, a.tenant, { echoInErrorResult: false });

  // connection states leave it untouched: failed, then the login is gone -> 409, still set
  await fakeMalice(request, a.tenant, { failMcp: true });
  expect((await refresh(request, a.id, user)).status()).toBe(502);
  const before = (await upstreamRow(request, a.id, user)).lastFailureAt;
  expect(before).not.toBeNull();
  await fakeMalice(request, a.tenant, { failMcp: false });
  await breakLogin(request, a);
  expect((await refresh(request, a.id, user)).status()).toBe(409);
  const after = await upstreamRow(request, a.id, user);
  expect(after.status).toBe('NEEDS_RECONNECT');
  expect(after.lastFailureAt).toBe(before);

  // never connected: 409, nothing set
  const never = await createUpstream(request, user, { url: fakeMcpUrl(newTenant('tc90n')), name: uniq('Nie TC90') });
  expect((await refresh(request, never.id, user)).status()).toBe(409);
  expect((await upstreamRow(request, never.id, user)).lastFailureAt).toBeNull();
});

test('TC-91 xitl-status: gelistet nur bei reconnect/unreachable, nur Namen und Zustände, Aufruf ohne Kontakt und Audit; sonst "nicht bekannt"', async ({ request }) => {
  const user = ST_LIST;
  const ok = await upstream(request, 'tc91o', user);
  const reconnect = await upstream(request, 'tc91r', user);
  const unreachable = await upstream(request, 'tc91u', user);
  const never = await createUpstream(request, user, { url: fakeMcpUrl(newTenant('tc91n')), name: uniq('Nie verbunden TC91') });
  const { accessToken: token } = await runOAuthFlow(request, uniq('Client tc91'), user);
  await breakLogin(request, reconnect);
  await fakeMalice(request, unreachable.tenant, { redirectMcp: true });

  const tools = await listTools(request, null, token);
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual([...['add_item', 'delete_all', 'list_items'].map((n) => `${ok.slug}_${n}`), 'xitl-status'].sort());
  const status = tools.find((t) => t.name === 'xitl-status')!;
  expect(status.annotations).toEqual({ readOnlyHint: true });
  expect(status.inputSchema).toEqual({ type: 'object', properties: {} });
  const desc = status.description!;
  expect(desc).toMatch(new RegExp(`${reconnect.name}[^\\n]*neu verbunden`));
  expect(desc).toMatch(new RegExp(`${unreachable.name}[^\\n]*nicht erreichbar`));
  expect(desc).not.toContain(never.name);
  expect(desc).not.toContain(ok.name);

  // nothing about the upstreams' insides anywhere in the answer
  const raw = JSON.stringify(await mcp(request, null, token, 'tools/list'));
  const secrets = [FAKE_HEADER_SECRET, '127.0.0.1', reconnect.slug, unreachable.slug];
  for (const t of [ok, reconnect, unreachable]) secrets.push(...(await fakeState(request, t.tenant)).tokens);
  for (const s of secrets) expect(desc, s).not.toContain(s);
  expect(raw).not.toContain(FAKE_HEADER_SECRET);
  expect(desc).not.toMatch(/https?:\/\//);
  expect(desc).not.toMatch(/\b(500|307)\b/);

  // calling it: not an error, same text, nothing contacted, nothing audited
  const reqs = () => Promise.all([ok, reconnect, unreachable].map(async (t) => (await fakeState(request, t.tenant)).mcpRequests));
  const reqsBefore = await reqs();
  const auditBefore = auditCount(user);
  const call = await callTool(request, null, token, 'xitl-status');
  expect(call.isError).toBeFalsy();
  const text = call.content[0]!.text;
  expect(text).toMatch(new RegExp(`${reconnect.name}: muss in xitl neu verbunden werden`));
  expect(text).toMatch(new RegExp(`${unreachable.name}: gerade nicht erreichbar`));
  expect(text).not.toContain(never.name);
  expect(await reqs()).toEqual(reqsBefore);
  expect(auditCount(user)).toBe(auditBefore);

  // only a never-connected upstream and a healthy one left: not listed; a call (cached list) answers all clear, still no contact/audit
  for (const t of [reconnect, unreachable]) expect((await request.delete(`/api/upstreams/${t.id}`, { headers: user })).status()).toBe(204);
  expect((await listTools(request, null, token)).map((t) => t.name)).not.toContain('xitl-status');
  const clear = await callTool(request, null, token, 'xitl-status');
  expect(clear.isError).toBeFalsy();
  expect(clear.content[0]!.text).toContain('Zurzeit fehlen keine Upstreams');
  expect(clear.content[0]!.text).not.toContain(never.name);
  expect(auditCount(user)).toBe(auditBefore);
});

test('TC-92 Instructions: Abschnitte nach Zustand; nach Heilung räumt das nächste tools/list auf; /mcp/<slug> unverändert', async ({ request }) => {
  const user = ST_INIT;
  const ok = await upstream(request, 'tc92o', user);
  const reconnect = await upstream(request, 'tc92r', user);
  const unreachable = await upstream(request, 'tc92u', user);
  const never = await createUpstream(request, user, { url: fakeMcpUrl(newTenant('tc92n')), name: uniq('Nie verbunden TC92') });
  const { accessToken: token } = await runOAuthFlow(request, uniq('Client tc92'), user);
  await breakLogin(request, reconnect);
  await fakeMalice(request, unreachable.tenant, { failMcp: true });

  const init = await mcp(request, null, token, 'initialize', INITIALIZE.params);
  const text: string = init.result.instructions;
  const body = (t: Up) => `Fake-Upstream ${t.tenant}: Einkaufsliste.`;
  const section = (t: { name: string }) => new RegExp(`## ${t.name}[^]*?(?=\\n## |$)`).exec(text)![0];
  expect(section(reconnect)).toContain('neu verbunden werden');
  expect(section(reconnect)).not.toContain(body(reconnect));
  expect(section(unreachable)).toContain('nicht erreichbar');
  expect(section(unreachable).indexOf('nicht erreichbar')).toBeLessThan(section(unreachable).indexOf(body(unreachable)));
  expect(section(never)).toContain('nicht verbunden');
  expect(section(ok)).toContain(body(ok));
  expect(section(ok)).not.toMatch(/nicht erreichbar|neu verbunden|nicht verbunden/);
  expect(sections(text)).toHaveLength(4);

  // /mcp/<slug> of a failing upstream: the JSON-RPC error with the generic text, as before
  const single = await parseRpc(await postMcp(request, unreachable.slug, token, LIST));
  expect(single.error.message).toContain(`„${unreachable.name}“`);
  expect(single.error.message).toContain('nicht erreichbar');
  expect(single.result).toBeUndefined();
  // (a stored NEEDS_RECONNECT is not contacted: an empty list there, unchanged by ADR-0022)
  const singleReconnect = await parseRpc(await postMcp(request, reconnect.slug, token, LIST));
  expect(singleReconnect.result.tools).toEqual([]);

  // healed: the next tools/list clears the state (the reconnect one is gone first)
  expect((await request.delete(`/api/upstreams/${reconnect.id}`, { headers: user })).status()).toBe(204);
  expect((await listTools(request, null, token)).map((t) => t.name)).toContain('xitl-status');
  expect((await upstreamRow(request, unreachable.id, user)).lastFailureAt).not.toBeNull();
  await fakeMalice(request, unreachable.tenant, { failMcp: false });
  const names = (await listTools(request, null, token)).map((t) => t.name);
  expect(names).not.toContain('xitl-status');
  expect(names).toContain(`${unreachable.slug}_list_items`);
  expect((await upstreamRow(request, unreachable.id, user)).lastFailureAt).toBeNull();
});

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: ST_UI });

  test('TC-93 Einstellungen @390x844: "Nicht erreichbar" + Hinweis + "Erneut prüfen"; geheilt -> "Verbunden"', async ({ page, request }) => {
    const up = await upstream(request, 'tc93', ST_UI);
    await fakeMalice(request, up.tenant, { failMcp: true });
    expect((await refresh(request, up.id, ST_UI)).status()).toBe(502);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/einstellungen');
    const item = page.locator('li.item', { hasText: up.name });
    await expect(item.locator('.badge.status-unreachable')).toHaveText('Nicht erreichbar');
    await expect(item).toContainText('Claude sieht seine Tools gerade nicht');
    await expect(item.locator('.badge.status-connected')).toHaveCount(0);
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noScroll()).toBe(true);

    // still failing: German error toast, badge stays
    await item.getByRole('button', { name: 'Erneut prüfen' }).click();
    await expect(page.getByText('Der Upstream ist gerade nicht erreichbar.')).toBeVisible();
    await expect(item.locator('.badge.status-unreachable')).toBeVisible();

    // healed: badge back, hint and button gone
    await fakeMalice(request, up.tenant, { failMcp: false });
    await item.getByRole('button', { name: 'Erneut prüfen' }).click();
    await expect(item.locator('.badge.status-connected')).toHaveText('Verbunden');
    await expect(item).not.toContainText('Claude sieht seine Tools gerade nicht');
    await expect(item.getByRole('button', { name: 'Erneut prüfen' })).toHaveCount(0);
    expect(await noScroll()).toBe(true);
  });
});
