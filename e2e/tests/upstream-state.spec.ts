// A failing upstream is visible on `/mcp` and in the app (ADR-0022): TC-90…95.
//
// One identity per case (ST_API, ST_LIST, ST_INIT, ST_UI, see support/db.ts):
// exact tool lists and instruction sections are asserted, and a connected
// upstream must never exist for anna (TC-16). The fake upstream is broken with
// the malice modes `failMcp` (500) / `redirectMcp` and healed by switching them
// off again; "needs reconnect" is an expired access token with a rejected refresh.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ANNA, ST_API, ST_FAULT, ST_INIT, ST_LIST, ST_PUSH, ST_UI, createUpstream, dbAll, uniq } from '../support/db.js';
import { INITIALIZE, LIST, parseRpc, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { BASE_URL, FAKE_HEADER_SECRET, FAKE_UPSTREAM } from '../support/paths.js';
import { outbox, outboxLines, settle, subscribe, unsubscribe } from '../support/push.js';
import { loadServiceWorker } from '../support/sw.js';
import { askUpstream, openStream, startCall } from '../support/approval.js';
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

test('TC-91 kein Platzhalter: /mcp listet genau die Tools der gesunden Upstreams; "xitl-status" ist unbekannt und wird verweigert', async ({ request }) => {
  const user = ST_LIST;
  const ok = await upstream(request, 'tc91o', user);
  const reconnect = await upstream(request, 'tc91r', user);
  const unreachable = await upstream(request, 'tc91u', user);
  await createUpstream(request, user, { url: fakeMcpUrl(newTenant('tc91n')), name: uniq('Nie verbunden TC91') });
  const { accessToken: token } = await runOAuthFlow(request, uniq('Client tc91'), user);
  await breakLogin(request, reconnect);
  await fakeMalice(request, unreachable.tenant, { failMcp: true });

  const res = await postMcp(request, null, token, LIST);
  expect(res.status()).toBe(200);
  const names = ((await parseRpc(res)).result.tools as { name: string }[]).map((t) => t.name).sort();
  expect(names).toEqual(['add_item', 'delete_all', 'list_items'].map((n) => `${ok.slug}_${n}`).sort());

  // a call to the old placeholder name: unknown, denied and audited like any unknown name (TC-63)
  const auditBefore = auditCount(user);
  const call = await callTool(request, null, token, 'xitl-status');
  expect(call.isError).toBe(true);
  expect(call.content[0]!.text).toContain('nicht bekannt');
  expect(auditCount(user)).toBe(auditBefore + 1);
  const [row] = dbAll('select toolName, decisionPath, outcome, upstreamId from AuditEntry where userId = ? order by id desc limit 1', uid(user));
  expect(row).toEqual({ toolName: 'xitl-status', decisionPath: 'unknown-tool', outcome: 'DENIED', upstreamId: null });
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
  expect((await listTools(request, null, token)).map((t) => t.name)).not.toContain(`${unreachable.slug}_list_items`);
  expect((await upstreamRow(request, unreachable.id, user)).lastFailureAt).not.toBeNull();
  await fakeMalice(request, unreachable.tenant, { failMcp: false });
  const names = (await listTools(request, null, token)).map((t) => t.name);
  expect(names).not.toContain('xitl-status');
  expect(names).toContain(`${unreachable.slug}_list_items`);
  expect((await upstreamRow(request, unreachable.id, user)).lastFailureAt).toBeNull();
});

test('TC-94 Push bei Übergängen: einmal an den Besitzer, nur Name + Zustand; nicht bei Dauerfehler, Erholung oder in der Sperrzeit; reconnect einmal', async ({ request }) => {
  const user = ST_PUSH;
  const a = await upstream(request, 'tc94a', user);
  const r = await upstream(request, 'tc94r', user);
  const phone = await subscribe(request, user);
  const annas = await subscribe(request, ANNA);
  try {
    // first failed contact of a healthy upstream -> exactly one push
    await fakeMalice(request, a.tenant, { failMcp: true });
    expect((await refresh(request, a.id, user)).status()).toBe(502);
    await expect.poll(() => outbox(phone).length).toBe(1);
    const [entry] = outbox(phone);
    expect(entry!.payload).toEqual({ type: 'upstream', upstreamId: a.id, name: a.name, state: 'unreachable' });
    expect(entry!.urgency).toBe('normal');
    expect(entry!.ttl).toBe(3600);
    const line = outboxLines(phone).join('\n');
    for (const secret of [...(await fakeState(request, a.tenant)).tokens, FAKE_HEADER_SECRET, FAKE_UPSTREAM, a.tenant]) expect(line).not.toContain(secret);
    expect(line).not.toMatch(/https?:\/\/(?!push\.example)/);
    expect(line).not.toMatch(/\b500\b/);

    // the service worker: title, tag upstream-<id> (replaces), tap opens Freigaben
    const sw = loadServiceWorker(await (await request.get('/sw.js')).text(), BASE_URL, async () => ({ ok: true, status: 200 }));
    await sw.push(entry!.payload);
    expect(sw.shown[0]!.title).toBe(`„${a.name}“ ist nicht erreichbar`);
    expect(sw.shown[0]!.options.tag).toBe(`upstream-${a.id}`);
    await sw.click(sw.shown[0]!);
    expect(sw.opened).toEqual([`${BASE_URL}/#/`]);
    await sw.push({ type: 'upstream', upstreamId: a.id, name: a.name, state: 'reconnect' });
    expect(sw.shown[1]!.title).toBe(`„${a.name}“ muss in xitl neu verbunden werden`);
    expect(sw.shown[1]!.options.tag).toBe(`upstream-${a.id}`);

    // still failing -> no push; recovery -> no push; failing again within the hour -> no push (cooldown)
    expect((await refresh(request, a.id, user)).status()).toBe(502);
    await fakeMalice(request, a.tenant, { failMcp: false });
    expect((await refresh(request, a.id, user)).status()).toBe(200);
    await fakeMalice(request, a.tenant, { failMcp: true });
    expect((await refresh(request, a.id, user)).status()).toBe(502);
    await settle();
    expect(outbox(phone)).toHaveLength(1);

    // reconnect (refresh rejected), two concurrent failing contacts -> one push with state reconnect
    await breakLogin(request, r);
    const both = await Promise.all([refresh(request, r.id, user), refresh(request, r.id, user)]);
    expect(both.map((x) => x.status())).toEqual([409, 409]);
    await expect.poll(() => outbox(phone).length).toBe(2);
    await settle();
    expect(outbox(phone)).toHaveLength(2);
    expect(outbox(phone)[1]!.payload).toEqual({ type: 'upstream', upstreamId: r.id, name: r.name, state: 'reconnect' });

    // another user's device never gets any of it
    expect(outbox(annas)).toEqual([]);
  } finally {
    await unsubscribe(request, user, phone);
    await unsubscribe(request, ANNA, annas);
  }
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

test.describe('im Browser (Freigaben)', () => {
  test.use({ extraHTTPHeaders: ST_FAULT });

  test('TC-95 Freigaben @390x844: "Störung"-Karten über gehaltenen Aufrufen, live per SSE, Snapshot, andere Nutzer sehen nichts', async ({ page, request }) => {
    const user = ST_FAULT;
    const healthy = await upstream(request, 'tc95u', user);
    const reconnect = await upstream(request, 'tc95r', user);
    await breakLogin(request, reconnect);
    expect((await refresh(request, reconnect.id, user)).status()).toBe(409);

    // API: the plain list and the stream's snapshot carry the faults (names + states only)
    const faults = await (await request.get('/api/upstreams/faults', { headers: user })).json();
    expect(faults).toEqual([{ id: reconnect.id, name: reconnect.name, state: 'reconnect', since: null }]);
    expect(await (await request.get('/api/upstreams/faults', { headers: ST_UI })).json()).not.toContainEqual(expect.objectContaining({ id: reconnect.id }));
    const stream = await openStream(user);
    const other = await openStream(ST_UI);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/');
    const reconnectCard = page.locator('article.fault', { hasText: reconnect.name });
    await expect(reconnectCard).toContainText('Störung');
    await expect(reconnectCard).toContainText('neu verbunden werden');
    await expect(reconnectCard.getByRole('button', { name: 'Neu verbinden' })).toBeVisible();
    await expect(page.getByText('Keine offenen Freigaben.')).toHaveCount(0);

    // live: the healthy one fails -> its card appears without reload, with "seit"
    await fakeMalice(request, healthy.tenant, { failMcp: true });
    expect((await refresh(request, healthy.id, user)).status()).toBe(502);
    const card = page.locator('article.fault', { hasText: healthy.name });
    await expect(card).toContainText(/nicht erreichbar seit \d\d:\d\d Uhr/);
    await expect(card.getByRole('button', { name: 'Erneut prüfen' })).toBeVisible();
    // names sort "Up tc95r…" before "Up tc95u…"
    await expect.poll(() => stream.events.filter((e) => e.event === 'upstreams').at(-1)?.data).toEqual([
      { id: reconnect.id, name: reconnect.name, state: 'reconnect', since: null },
      { id: healthy.id, name: healthy.name, state: 'unreachable', since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    ]);
    expect(stream.events[0]!.event).toBe('snapshot');
    expect(stream.events[1]!.event).toBe('upstreams');
    expect(other.events.filter((e) => e.event === 'upstreams').flatMap((e) => e.data).map((f: any) => f.id)).not.toContain(healthy.id);
    expect(JSON.stringify(stream.events)).not.toContain(FAKE_UPSTREAM);

    // a held call still shows normally below the cards
    const { up: askUp, token } = await askUpstream(request, 'tc95a', {}, user);
    const held = startCall(request, askUp.slug, token, 'add_item', { item: 'Milch' });
    const approval = page.locator('article.approval');
    await expect(approval).toBeVisible();
    const cardBox = (await card.boundingBox())!;
    expect((await approval.boundingBox())!.y).toBeGreaterThan(cardBox.y);
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noScroll()).toBe(true);
    await held;

    // healed + "Erneut prüfen" -> the card leaves (toast), the other stays
    await fakeMalice(request, healthy.tenant, { failMcp: false });
    await card.getByRole('button', { name: 'Erneut prüfen' }).click();
    await expect(page.getByText(`„${healthy.name}“ ist wieder erreichbar`)).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(reconnectCard).toBeVisible();

    // the snapshot on (re)connect: a reload shows the current faults
    await page.reload();
    await expect(reconnectCard).toBeVisible();
    await expect(page.locator('article.fault')).toHaveCount(1);
    expect(await noScroll()).toBe(true);
    await stream.close();
    await other.close();
  });
});
