// Pause an access (ADR-0024): TC-102 (API), TC-103 (the gate), TC-104 (held
// calls, the re-check after an approval, stale pushes), TC-105 (UI).
//
// One user per case (pa-*): /mcp of each lists only what the case created,
// and nothing here connects an upstream for anna (TC-16).
import crypto from 'node:crypto';
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { PA_API, PA_GATE, PA_HELD, PA_OTHER, PA_UI, dbAll, dbRun, uniq } from '../support/db.js';
import { BASE_URL } from '../support/paths.js';
import { INITIALIZE, LIST, deleteMcp, openMcpSession, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeState } from '../support/upstream.js';
import { askUpstream, decide, openStream, pendingList, startCall, waitPending } from '../support/approval.js';
import { firstPushes, outbox, subscribe, unsubscribe } from '../support/push.js';
import { loadServiceWorker } from '../support/sw.js';

test.use({ extraHTTPHeaders: {} });

type User = Record<string, string>;
interface Client {
  id: number;
  name: string;
  kind: 'OAUTH' | 'TOKEN';
  pausedAt: string | null;
}

const PAUSED = { error: 'access_paused', message: 'Zugang pausiert. / Access paused.' };
const iso = (d: Date) => d.toISOString().replace('Z', '+00:00');
const corsHeaders = (res: APIResponse) => Object.keys(res.headers()).filter((h) => h.toLowerCase().startsWith('access-control-'));
const uniqOrigin = (prefix: string) => `https://${prefix}-${crypto.randomBytes(4).toString('hex')}.example`;

async function token(request: APIRequestContext, user: User, scope: { upstreamId: number } | 'all', allowedOrigins: string[] = []) {
  const url = scope === 'all' ? '/api/mcp/tokens' : `/api/upstreams/${scope.upstreamId}/tokens`;
  const res = await request.post(url, { headers: user, data: { name: uniq('Token pa'), allowedOrigins } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { client: Client; token: string };
}
async function clients(request: APIRequestContext, user: User): Promise<Client[]> {
  return (await request.get('/api/mcp/clients', { headers: user })).json();
}
const patchClient = (request: APIRequestContext, user: User, id: number, data: unknown) =>
  request.patch(`/api/mcp/clients/${id}`, { headers: user, data });
async function setPaused(request: APIRequestContext, user: User, id: number, paused: boolean): Promise<Client> {
  const res = await patchClient(request, user, id, { paused });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const clientRowId = (clientId: string) => dbAll('select id from McpClient where clientId = ?', clientId)[0].id as number;
const auditByApproval = (approvalId: string) => dbAll('select * from AuditEntry where approvalId = ?', approvalId)[0];

test('TC-102 API: PATCH paused auf Token und OAuth, erste Pause bleibt, Fortsetzen, kombiniert mit name, 400 bei Unsinn, fremd -> 404', async ({ request }) => {
  const tok = await token(request, PA_API, 'all');
  expect(tok.client.pausedAt).toBeNull();
  const oauth = await runOAuthFlow(request, uniq('OAuth tc102'), PA_API);
  const oauthId = clientRowId(oauth.clientId);

  for (const id of [tok.client.id, oauthId]) {
    const paused = await setPaused(request, PA_API, id, true);
    expect(paused.pausedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await clients(request, PA_API)).find((c) => c.id === id)!.pausedAt).toBe(paused.pausedAt);
    // pausing again keeps the first pausedAt
    await new Promise((r) => setTimeout(r, 20));
    expect((await setPaused(request, PA_API, id, true)).pausedAt).toBe(paused.pausedAt);
    // resume
    expect((await setPaused(request, PA_API, id, false)).pausedAt).toBeNull();
    expect((await clients(request, PA_API)).find((c) => c.id === id)!.pausedAt).toBeNull();
  }

  // combined with name: both apply
  const both = await patchClient(request, PA_API, tok.client.id, { name: 'Pausiert und umbenannt', paused: true });
  expect(both.status()).toBe(200);
  expect(await both.json()).toMatchObject({ name: 'Pausiert und umbenannt', pausedAt: expect.any(String) });
  // ... and name alone leaves the pause alone
  expect(await (await patchClient(request, PA_API, tok.client.id, { name: 'Nur Name' })).json()).toMatchObject({ name: 'Nur Name', pausedAt: expect.any(String) });

  // paused not a boolean: German 400, nothing changed
  for (const bad of ['ja', 1, null, { x: true }]) {
    const res = await patchClient(request, PA_API, oauthId, { paused: bad });
    expect(res.status(), JSON.stringify(bad)).toBe(400);
    expect((await res.json()).error).toBe('paused muss true oder false sein.');
  }
  expect((await clients(request, PA_API)).find((c) => c.id === oauthId)!.pausedAt).toBeNull();

  // another user's client: 404, unchanged
  for (const paused of [true, false]) {
    expect((await patchClient(request, PA_OTHER, tok.client.id, { paused })).status()).toBe(404);
    expect((await patchClient(request, PA_OTHER, oauthId, { paused })).status()).toBe(404);
  }
  expect(dbAll('select pausedAt from McpClient where id = ?', oauthId)[0].pausedAt).toBeNull();
  expect(dbAll('select pausedAt from McpClient where id = ?', tok.client.id)[0].pausedAt).not.toBeNull();

  // none of name / allowedOrigins / paused: 400 as before
  const empty = await patchClient(request, PA_API, tok.client.id, {});
  expect(empty.status()).toBe(400);
  expect((await empty.json()).error).toBe('name darf nicht leer sein');
});

test('TC-103 Gate: pausiertes Token/OAuth -> 403 access_paused ohne Wirkung; CORS nur bei erlaubter Origin; Refresh geht; Fortsetzen stellt alles wieder her', async ({ request }) => {
  const up = await connectedUpstream(request, 'tc103', { defaultPolicy: 'ASK', name: uniq('Up tc103') }, PA_GATE);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: PA_GATE })).status()).toBe(200);
  const view = (await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: PA_GATE })).json()) as { tools: { id: number; name: string }[] };
  const toolId = (name: string) => view.tools.find((t) => t.name === name)!.id;
  expect((await request.patch(`/api/upstreams/${up.id}/tools/${toolId('list_items')}`, { headers: PA_GATE, data: { policy: 'ALLOW' } })).status()).toBe(200);

  const listed = uniqOrigin('tc103');
  const one = await token(request, PA_GATE, { upstreamId: up.id }, [listed]);
  const all = await token(request, PA_GATE, 'all');
  const bystander = await token(request, PA_GATE, 'all');
  const uid = dbAll('select id from User where username = ?', PA_GATE['Remote-User'])[0].id as number;

  // a per-client rule (delete_all ALLOW for `one`) and a snooze (add_item for `one`)
  expect((await request.put(`/api/upstreams/${up.id}/tools/${toolId('delete_all')}/clients/${one.client.id}`, { headers: PA_GATE, data: { policy: 'ALLOW' } })).status()).toBe(200);
  const first = startCall(request, up.slug, one.token, 'add_item', { item: 'vor der Pause' });
  const p0 = await waitPending(request, up.id, 'add_item', PA_GATE);
  expect((await decide(request, p0.id, { decision: 'approve', snoozeMinutes: 60 }, PA_GATE)).status()).toBe(200);
  expect((await first).isError).toBeFalsy();
  expect(dbAll('select count(*) n from Snooze where mcpClientId = ?', one.client.id)[0].n).toBe(1);

  // sessions opened while active
  const sOne = await openMcpSession(request, up.slug, one.token);
  const sAll = await openMcpSession(request, null, all.token);

  // pause both
  await setPaused(request, PA_GATE, one.client.id, true);
  await setPaused(request, PA_GATE, all.client.id, true);
  // old timestamps, so a bump (lastUsedAt, session lastSeenAt) would show
  const longAgo = iso(new Date(Date.now() - 10 * 60_000));
  dbRun('update McpClient set lastUsedAt = ? where id in (?, ?)', longAgo, one.client.id, all.client.id);
  dbRun('update McpSession set lastSeenAt = ? where id in (?, ?)', longAgo, sOne.sessionId, sAll.sessionId);
  const sessionsBefore = dbAll('select id, lastSeenAt, endedAt, callCount from McpSession where id in (?, ?) order by id', sOne.sessionId, sAll.sessionId);
  const audits = () => dbAll('select count(*) c from AuditEntry where userId = ?', uid)[0].c as number;
  const auditBefore = audits();
  const reqsBefore = (await fakeState(request, up.tenant)).mcpRequests;
  const callsBefore = (await fakeState(request, up.tenant)).calls;

  const expectPaused = async (res: APIResponse, label: string) => {
    expect(res.status(), label).toBe(403);
    expect(await res.json(), label).toEqual(PAUSED);
  };
  for (const { slug, t, s } of [
    { slug: up.slug, t: one.token, s: sOne },
    { slug: null, t: all.token, s: sAll },
  ]) {
    const prefix = slug === null ? `${up.slug}_` : '';
    const label = slug ?? '/mcp';
    await expectPaused(await postMcp(request, slug, t, INITIALIZE), `${label} initialize`);
    await expectPaused(await postMcp(request, slug, t, LIST), `${label} tools/list`);
    await expectPaused(
      await postMcp(request, slug, t, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: `${prefix}list_items`, arguments: {} } }),
      `${label} tools/call`,
    );
    await expectPaused(await s.post(LIST), `${label} with session`);
    await expectPaused(await s.end(), `${label} DELETE session`);
    await expectPaused(await request.fetch(slug === null ? '/mcp' : `/mcp/${slug}`, { method: 'GET', headers: { Authorization: `Bearer ${t}`, Accept: 'text/event-stream' } }), `${label} GET`);
    // no Origin: no CORS on the refusal
    expect(corsHeaders(await postMcp(request, slug, t, LIST)), label).toEqual([]);
  }

  // with an Origin the token lists: the same 403, readable by the page
  const withListed = await postMcp(request, up.slug, one.token, LIST, { headers: { Origin: listed } });
  await expectPaused(withListed, 'listed origin');
  expect(withListed.headers()['access-control-allow-origin']).toBe(listed);
  expect(withListed.headers()['vary']).toMatch(/\bOrigin\b/);
  // an origin it does not list: origin_not_allowed first, no CORS
  const withOther = await postMcp(request, up.slug, one.token, LIST, { headers: { Origin: uniqOrigin('tc103-other') } });
  expect(withOther.status()).toBe(403);
  expect(await withOther.json()).toEqual({ error: 'origin_not_allowed' });
  expect(corsHeaders(withOther)).toEqual([]);

  // wrong / no token on the paused client's endpoint: still the 401 challenge
  for (const bearer of [null, 'xitl_' + 'B'.repeat(43), 'kein-token']) {
    const res = await postMcp(request, up.slug, bearer, LIST);
    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toContain('Bearer');
  }

  // nothing happened
  expect(audits()).toBe(auditBefore);
  expect((await fakeState(request, up.tenant)).mcpRequests).toBe(reqsBefore);
  expect((await fakeState(request, up.tenant)).calls).toEqual(callsBefore);
  await new Promise((r) => setTimeout(r, 300)); // touchTokenLastUsed is fire-and-forget
  expect(dbAll('select lastUsedAt from McpClient where id in (?, ?)', one.client.id, all.client.id).map((r) => r.lastUsedAt)).toEqual([longAgo, longAgo]);
  expect(dbAll('select id, lastSeenAt, endedAt, callCount from McpSession where id in (?, ?) order by id', sOne.sessionId, sAll.sessionId)).toEqual(sessionsBefore);

  // another client of the same user is unaffected
  const other = await callTool(request, null, bystander.token, `${up.slug}_list_items`);
  expect(other.isError).toBeFalsy();

  // a paused OAuth client: 403 access_paused, never CORS; refresh still mints, the gate refuses it
  const oauth = await runOAuthFlow(request, uniq('OAuth tc103'), PA_GATE);
  const oauthId = clientRowId(oauth.clientId);
  await setPaused(request, PA_GATE, oauthId, true);
  for (const headers of [{}, { Origin: listed }]) {
    const res = await postMcp(request, null, oauth.accessToken, LIST, { headers });
    await expectPaused(res, 'oauth');
    expect(corsHeaders(res)).toEqual([]);
  }
  const refreshed = await request.post('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: oauth.clientId } });
  expect(refreshed.status()).toBe(200);
  const newAccess = (await refreshed.json()).access_token as string;
  expect(newAccess).toBeTruthy(); // (may equal the old blob within the same second: same claims)
  await expectPaused(await postMcp(request, null, newAccess, LIST), 'oauth refreshed');
  expect((await deleteMcp(request, null, newAccess)).status()).toBe(403);
  // resumed: the refreshed token works at once
  await setPaused(request, PA_GATE, oauthId, false);
  expect((await postMcp(request, null, newAccess, LIST)).status()).toBe(200);

  // resume the one-upstream token: works at once, its rule and snooze still apply
  await setPaused(request, PA_GATE, one.client.id, false);
  expect(dbAll('select count(*) n from Snooze where mcpClientId = ?', one.client.id)[0].n).toBe(1);
  expect(dbAll('select count(*) n from ClientToolPolicy where mcpClientId = ?', one.client.id)[0].n).toBe(1);
  const del = await callTool(request, up.slug, one.token, 'delete_all');
  expect(del.isError).toBeFalsy();
  const snoozed = await callTool(request, up.slug, one.token, 'add_item', { item: 'nach der Pause' });
  expect(snoozed.isError).toBeFalsy();
  const state = await fakeState(request, up.tenant);
  expect(state.calls.delete_all).toBe((callsBefore.delete_all ?? 0) + 1);
  expect(state.calls.add_item).toBe((callsBefore.add_item ?? 0) + 1);
  await expect.poll(() => dbAll('select lastUsedAt from McpClient where id = ?', one.client.id)[0].lastUsedAt).not.toBe(longAgo);
  // its session is still there and usable
  expect((await sOne.post(LIST)).status()).toBe(200);
  // the all-upstreams token, resumed, too
  await setPaused(request, PA_GATE, all.client.id, false);
  expect((await callTool(request, null, all.token, `${up.slug}_list_items`)).isError).toBeFalsy();
});

test('TC-104 Wartende Aufrufe: Pausieren beendet sie sofort (+paused), fremde bleiben; Freigabe nach Pause -> nicht weitergeleitet; Push ersetzt die Benachrichtigung (auch bei Widerruf)', async ({ request }) => {
  const { up, token, clientId } = await askUpstream(request, 'tc104', {}, PA_HELD);
  const rowId = clientRowId(clientId);
  const second = await runOAuthFlow(request, uniq('Client tc104 b'), PA_HELD);
  const secondId = clientRowId(second.clientId);
  const ep = await subscribe(request, PA_HELD);
  const stream = await openStream(PA_HELD);
  const source = await (await request.get('/sw.js')).text();
  const sw = loadServiceWorker(source, BASE_URL, async () => ({ ok: false, status: 500 }));
  try {
    // two held calls, one per client
    const heldA = startCall(request, up.slug, token, 'add_item', { item: 'A' });
    const pA = await waitPending(request, up.id, 'add_item', PA_HELD);
    const heldB = startCall(request, up.slug, second.accessToken, 'delete_all');
    const pB = await waitPending(request, up.id, 'delete_all', PA_HELD);
    await expect.poll(() => firstPushes(ep).filter((e) => e.payload.type === 'approval').length).toBe(2);
    for (const e of outbox(ep)) await sw.push(e.payload);

    // pause the first client: its call ends denied at once
    const t0 = Date.now();
    await setPaused(request, PA_HELD, rowId, true);
    const result = await heldA;
    expect(Date.now() - t0).toBeLessThan(2500); // at once, not at the 5 s timeout
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('pausiert');
    expect(auditByApproval(pA.id)).toMatchObject({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+paused', mcpClientId: rowId });
    expect((await decide(request, pA.id, { decision: 'approve' }, PA_HELD)).status()).toBe(409);
    // the card leaves Freigaben live; the other client's call stays
    await expect.poll(() => stream.events.some((e) => e.event === 'resolved' && e.data.id === pA.id && e.data.kind === 'paused')).toBe(true);
    expect((await pendingList(request, PA_HELD)).map((p) => p.id)).toEqual([pB.id]);
    // the stale notification is replaced
    await expect.poll(() => outbox(ep).find((e) => e.payload.type === 'resolved' && e.payload.id === pA.id)?.payload).toEqual({ type: 'resolved', id: pA.id, outcome: 'paused' });
    const nA = sw.shown.length;
    await sw.push(outbox(ep).find((e) => e.payload.type === 'resolved' && e.payload.id === pA.id)!.payload);
    expect(sw.shown.filter((x) => x.options?.tag === `approval-${pA.id}` && !x.closed)).toEqual([]);
    expect(sw.shown).toHaveLength(nA);

    // revoking the second client: the same "resolved" push (outcome revoked)
    expect((await request.delete(`/api/mcp/clients/${secondId}`, { headers: PA_HELD })).status()).toBe(204);
    expect((await heldB).isError).toBe(true);
    expect(auditByApproval(pB.id)).toMatchObject({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+revoked' });
    await expect.poll(() => outbox(ep).find((e) => e.payload.type === 'resolved' && e.payload.id === pB.id)?.payload).toEqual({ type: 'resolved', id: pB.id, outcome: 'revoked' });
    const nB = sw.shown.length;
    await sw.push(outbox(ep).find((e) => e.payload.type === 'resolved' && e.payload.id === pB.id)!.payload);
    expect(sw.shown.filter((x) => x.options?.tag === `approval-${pB.id}` && !x.closed)).toEqual([]);
    expect(sw.shown).toHaveLength(nB);

    // the race: a pause that lands after evaluation but misses the held call
    // (written straight to the DB, so nothing settles it) -> the approval is
    // re-checked and refused, nothing reaches the upstream
    await setPaused(request, PA_HELD, rowId, false);
    const heldC = startCall(request, up.slug, token, 'add_item', { item: 'Rennen' });
    const pC = await waitPending(request, up.id, 'add_item', PA_HELD);
    dbRun('update McpClient set pausedAt = ? where id = ?', iso(new Date()), rowId);
    expect((await decide(request, pC.id, { decision: 'approve' }, PA_HELD)).status()).toBe(200);
    const raced = await heldC;
    expect(raced.isError).toBe(true);
    expect(raced.content[0]!.text).toContain('pausiert');
    expect(auditByApproval(pC.id)).toMatchObject({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+paused' });
    const calls = (await fakeState(request, up.tenant)).calls;
    expect(calls.add_item ?? 0).toBe(0);
    expect(calls.delete_all ?? 0).toBe(0);
  } finally {
    await stream.close();
    await unsubscribe(request, PA_HELD, ep);
  }
});

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: PA_UI });

  test('TC-105 UI @390x844: "Pausieren" an jeder Zeile, Chip "pausiert" + "Fortsetzen" (übersteht Reload), Toasts, kein Querscrollen', async ({ page, request }) => {
    const tok = await token(request, PA_UI, 'all');
    const oauthName = uniq('OAuth tc105');
    await runOAuthFlow(request, oauthName, PA_UI);
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/einstellungen');
    const list = page.getByRole('list', { name: 'MCP-Clients' });
    const toast = page.locator('.toast');

    for (const name of [tok.client.name, oauthName]) {
      const row = list.locator('li.item', { hasText: name });
      await expect(row.getByRole('button', { name: 'Pausieren' })).toBeVisible();
      await expect(row.getByTestId('client-paused')).toHaveCount(0);
      await row.getByRole('button', { name: 'Pausieren' }).click();
      await expect(toast).toContainText(`„${name}“ pausiert`);
      await expect(row.getByTestId('client-paused')).toHaveText('pausiert');
      await expect(row.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
      expect(await noScroll()).toBe(true);
    }
    // survives a reload
    await page.reload();
    for (const name of [tok.client.name, oauthName]) {
      const row = list.locator('li.item', { hasText: name });
      await expect(row.getByTestId('client-paused')).toHaveText('pausiert');
      await expect(row.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
    }
    expect(await noScroll()).toBe(true);
    await page.screenshot({ path: test.info().outputPath('tc105-paused.png') });

    // resume removes the chip
    const tokRow = list.locator('li.item', { hasText: tok.client.name });
    await tokRow.getByRole('button', { name: 'Fortsetzen' }).click();
    await expect(toast).toContainText(`„${tok.client.name}“ fortgesetzt`);
    await expect(tokRow.getByTestId('client-paused')).toHaveCount(0);
    await expect(tokRow.getByRole('button', { name: 'Pausieren' })).toBeVisible();

    // a failure: a German error toast (the client was revoked meanwhile)
    const oauthRow = list.locator('li.item', { hasText: oauthName });
    const oauthId = (await clients(request, PA_UI)).find((c) => c.name === oauthName)!.id;
    expect((await request.delete(`/api/mcp/clients/${oauthId}`, { headers: PA_UI })).status()).toBe(204);
    await oauthRow.getByRole('button', { name: 'Fortsetzen' }).click();
    await expect(page.locator('.toast.toast-error')).toHaveText(`„${oauthName}“ gibt es nicht mehr.`);
    expect(await noScroll()).toBe(true);
  });
});
