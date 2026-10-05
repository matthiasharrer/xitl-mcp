// The unified `/mcp` endpoint (ADR-0014, ADR-0017): TC-61…TC-68. Written from
// the ADRs and docs/testing.md, not from the implementation.
//
// Own identities (UNI_A, UNI_B, UNI_DEGRADE, UNI_EMPTY, see support/db.ts): matthias's `/mcp`
// would list every upstream the other specs left behind, and anna must never
// hold a connected upstream (TC-16). Each case creates its own tenants on the
// fake upstream, so the per-tenant call counters prove what reached whom.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { UNI_A, UNI_B, UNI_DEGRADE, UNI_EMPTY, createUpstream, dbAll, uniq, uniqSlug } from '../support/db.js';
import { INITIALIZE, LIST, deleteUnified, openMcpSession, openUnifiedSession, parseRpc, postMcp, postUnified, runOAuthFlow } from '../support/mcpClient.js';
import { BASE_URL, MCP_TOKEN } from '../support/paths.js';
import { callTool, connectedUpstream, fakeControl, fakeMalice, fakeMcpUrl, fakeState, listTools, mcp, newTenant } from '../support/upstream.js';
import { decide, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

const STAMP = '[xitl] Erfordert Freigabe durch';
type User = Record<string, string>;

async function toolsView(request: APIRequestContext, upstreamId: number, user: User) {
  const res = await request.get(`/api/upstreams/${upstreamId}/tools`, { headers: user });
  expect(res.status()).toBe(200);
  return (await res.json()) as { tools: { id: number; name: string }[] };
}
async function setToolPolicy(request: APIRequestContext, upstreamId: number, name: string, policy: string | null, user: User) {
  const tool = (await toolsView(request, upstreamId, user)).tools.find((t) => t.name === name)!;
  const res = await request.patch(`/api/upstreams/${upstreamId}/tools/${tool.id}`, { headers: user, data: { policy } });
  expect(res.status()).toBe(200);
  return tool.id;
}
const clientRowId = (clientId: string) => dbAll('select id from McpClient where clientId = ?', clientId)[0].id as number;
const userId = (u: User) => dbAll('select id from User where username = ?', u['Remote-User'])[0].id as number;
const auditRows = (uid: number, afterId = 0) => dbAll("select * from AuditEntry where userId = ? and endpoint = '/mcp' and id > ? order by id", uid, afterId);
const maxAuditId = () => (dbAll('select max(id) m from AuditEntry')[0].m as number | null) ?? 0;
const sections = (instructions: string) => instructions.split('\n').filter((l) => l.startsWith('## '));

async function connectAndRefresh(request: APIRequestContext, prefix: string, overrides: Record<string, unknown>, user: User) {
  const up = await connectedUpstream(request, prefix, overrides, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  return up;
}

/** Two connected upstreams of UNI_A and one OAuth client of hers.
 * ua: default ASK, list_items ALLOW, delete_all DENY, add_item follows the default (ASK).
 * ub: default ALLOW, but this client is DENIED add_item (per-client rule). */
async function twoUpstreams(request: APIRequestContext, prefix: string, user: User = UNI_A) {
  const ua = await connectAndRefresh(request, `${prefix}a`, { defaultPolicy: 'ASK', name: uniq(`Haushalt ${prefix}`), description: `Aufgaben von ${prefix}` }, user);
  await setToolPolicy(request, ua.id, 'list_items', 'ALLOW', user);
  await setToolPolicy(request, ua.id, 'delete_all', 'DENY', user);
  const ub = await connectAndRefresh(request, `${prefix}b`, { defaultPolicy: 'ALLOW', name: uniq(`Rezepte ${prefix}`), description: `Rezepte von ${prefix}` }, user);
  const client = await runOAuthFlow(request, uniq(`Client ${prefix}`), user);
  const addItemId = (await toolsView(request, ub.id, user)).tools.find((t) => t.name === 'add_item')!.id;
  const put = await request.put(`/api/upstreams/${ub.id}/tools/${addItemId}/clients/${clientRowId(client.clientId)}`, { headers: user, data: { policy: 'DENY' } });
  expect(put.status()).toBe(200);
  return { ua, ub, token: client.accessToken, clientId: client.clientId };
}

test('TC-61 initialize auf /mcp: Präfix-Zeile + Abschnitt je Upstream; tools/list mit <slug>_-Namen, Stempel/Verstecken wie auf /mcp/<slug>', async ({ request }) => {
  const { ua, ub, token } = await twoUpstreams(request, 'tc61');

  const init = await mcp(request, null, token, 'initialize', INITIALIZE.params);
  const text: string = init.result.instructions;
  expect(text.startsWith('Über xitl vermittelt')).toBe(true);
  expect(Object.keys(init.result.capabilities)).toEqual(['tools']);
  // exactly one section per upstream, naming its slug prefix
  expect(sections(text)).toHaveLength(2);
  for (const up of [ua, ub]) {
    const line = sections(text).find((l) => l.includes(up.name));
    expect(line, `section for ${up.name}`).toContain(`${up.slug}_`);
    expect(text).toContain(`Fake-Upstream ${up.tenant}: Einkaufsliste.`); // its own instructions
  }
  expect(text).toContain(`Aufgaben von tc61`); // ua's description
  expect(text).toContain(`Rezepte von tc61`); // ub's description

  const tools = await listTools(request, null, token);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // ua: delete_all DENY -> hidden; add_item ASK -> stamped; list_items ALLOW -> exact
  // ub: add_item denied for THIS client -> hidden; the rest follows ALLOW
  expect(Object.keys(byName).sort()).toEqual([`${ua.slug}_add_item`, `${ua.slug}_list_items`, `${ub.slug}_delete_all`, `${ub.slug}_list_items`].sort());
  expect(byName[`${ua.slug}_list_items`]).toEqual({
    name: `${ua.slug}_list_items`,
    description: 'Lists the shopping list items.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  });
  expect(byName[`${ua.slug}_add_item`]!.description).toContain(STAMP);
  expect(byName[`${ua.slug}_add_item`]!.inputSchema).toEqual({ type: 'object', properties: { item: { type: 'string' } }, required: ['item'] });
  expect(byName[`${ub.slug}_list_items`]!.description).not.toContain(STAMP);
  expect(byName[`${ub.slug}_delete_all`]!.description).not.toContain(STAMP);

  // the same view as on /mcp/<slug>, only prefixed
  const single = await listTools(request, ua.slug, token);
  expect(single.map((t) => `${ua.slug}_${t.name}`).sort()).toEqual(tools.filter((t) => t.name.startsWith(`${ua.slug}_`)).map((t) => t.name).sort());
});

test('TC-62 ua_list_items nur an ua, Audit /mcp; ask hält + Freigabe; Pause von /mcp gilt auch auf /mcp/ua', async ({ request }) => {
  const { ua, ub, token } = await twoUpstreams(request, 'tc62');
  const uid = userId(UNI_A);
  const base = maxAuditId();

  const result = await callTool(request, null, token, `${ua.slug}_list_items`, { egal: 1 });
  expect(result).toEqual({ content: [{ type: 'text', text: 'Milch, Brot' }], structuredContent: { items: ['Milch', 'Brot'] } });
  expect((await fakeState(request, ua.tenant)).calls.list_items).toBe(1);
  expect(await fakeState(request, ub.tenant).then((s) => s.calls)).toEqual({});
  const rows = auditRows(uid, base);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ endpoint: '/mcp', upstreamId: ua.id, toolName: 'list_items', outcome: 'FORWARDED', policy: 'ALLOW', decisionPath: 'policy:tool' });
  expect(JSON.parse(rows[0].arguments)).toEqual({ egal: 1 });

  // ask: held, the card names the upstream, forwarded after "Erlauben"
  const held = callTool(request, null, token, `${ua.slug}_add_item`, { item: 'Eier' });
  const p = await waitPending(request, ua.id, 'add_item', UNI_A);
  expect(p.tool).toBe('add_item');
  expect(p.upstream).toMatchObject({ id: ua.id, slug: ua.slug, name: ua.name });
  expect((await fakeState(request, ua.tenant)).calls.add_item ?? 0).toBe(0);
  expect((await decide(request, p.id, { decision: 'approve', snoozeMinutes: 60 }, UNI_A)).status()).toBe(200);
  expect(await held).toEqual({ content: [{ type: 'text', text: 'hinzugefügt: Eier' }] });
  expect((await fakeState(request, ua.tenant)).calls.add_item).toBe(1);
  const approved = dbAll('select * from AuditEntry where approvalId = ?', p.id)[0];
  expect(approved).toMatchObject({ endpoint: '/mcp', upstreamId: ua.id, toolName: 'add_item', outcome: 'FORWARDED', decisionPath: 'policy:upstream-default+approved:page' });

  // shared rules: the snooze given via /mcp applies to the same tool on /mcp/<slug>
  const again = await callTool(request, ua.slug, token, 'add_item', { item: 'Brot' });
  expect(again).toEqual({ content: [{ type: 'text', text: 'hinzugefügt: Brot' }] });
  expect(dbAll('select * from AuditEntry where upstreamId = ? order by id desc limit 1', ua.id)[0]).toMatchObject({ endpoint: `/mcp/${ua.slug}`, outcome: 'FORWARDED', decisionPath: 'snooze' });
  // and back on /mcp: still no question
  const third = await callTool(request, null, token, `${ua.slug}_add_item`, { item: 'Käse' });
  expect(third.isError).toBeFalsy();
  expect(dbAll('select * from AuditEntry where upstreamId = ? order by id desc limit 1', ua.id)[0]).toMatchObject({ endpoint: '/mcp', decisionPath: 'snooze' });
  expect(await fakeState(request, ub.tenant).then((s) => s.calls)).toEqual({}); // ub never touched
});

test('TC-63 Namen fail closed: ohne Präfix, unbekannter Slug/Tool, fremder Slug, leere Teile -> verweigert, nichts erreicht einen Tenant; DENY-Tool per Präfixname verweigert', async ({ request }) => {
  const { ua, ub, token } = await twoUpstreams(request, 'tc63');
  const other = await connectAndRefresh(request, 'tc63x', { defaultPolicy: 'ALLOW' }, UNI_B);
  const uid = userId(UNI_A);
  const base = maxAuditId();

  const unresolved = ['list_items', 'zz_list_items', `${other.slug}_list_items`, `${ua.slug}_`, '_list_items'];
  const attempts = [...unresolved, `${ub.slug}_nope`];
  for (const name of attempts) {
    const r = await callTool(request, null, token, name, { x: 1 });
    expect(r.isError, name).toBe(true);
    expect(r.content[0]!.text, name).toContain('nicht bekannt');
  }
  const rows = auditRows(uid, base);
  expect(rows, 'one audit row per attempt').toHaveLength(attempts.length);
  rows.forEach((row, i) => {
    expect(row, attempts[i]).toMatchObject({ outcome: 'DENIED', decisionPath: 'unknown-tool', endpoint: '/mcp' });
    if (i < unresolved.length) {
      expect(row.upstreamId, `${attempts[i]} resolves to no upstream`).toBeNull();
      expect(row.toolName).toBe(attempts[i]); // the full name as sent
    }
  });
  // nothing reached ANY tenant
  for (const t of [ua.tenant, ub.tenant, other.tenant]) expect(await fakeState(request, t).then((s) => s.calls), t).toEqual({});

  // a DENY tool called by its prefixed name: denied as on /mcp/<slug>
  const denied = await callTool(request, null, token, `${ua.slug}_delete_all`);
  expect(denied.isError).toBe(true);
  expect(denied.content[0]!.text).toContain('Verweigert');
  expect(denied.content[0]!.text).toContain('Denied');
  // a per-client DENY on ub as well
  const deniedClient = await callTool(request, null, token, `${ub.slug}_add_item`, { item: 'x' });
  expect(deniedClient.isError).toBe(true);
  const last = auditRows(uid, base).slice(attempts.length);
  expect(last[0]).toMatchObject({ upstreamId: ua.id, toolName: 'delete_all', outcome: 'DENIED', policy: 'DENY', decisionPath: 'policy:tool' });
  expect(last[1]).toMatchObject({ upstreamId: ub.id, toolName: 'add_item', outcome: 'DENIED', policy: 'DENY' });
  for (const t of [ua.tenant, ub.tenant, other.tenant]) expect(await fakeState(request, t).then((s) => s.calls), t).toEqual({});
});

test('TC-64 Degradation: kaputter/neu zu verbindender Upstream fehlt in tools/list (200), nie verbundener wird nicht kontaktiert', async ({ request }) => {
  const user = UNI_DEGRADE; // alone: the exact tool list is asserted
  const good = await connectAndRefresh(request, 'tc64g', { defaultPolicy: 'ALLOW', name: uniq('Gut TC64') }, user);
  const needsReconnect = await connectAndRefresh(request, 'tc64r', { defaultPolicy: 'ALLOW', name: uniq('Reconnect TC64') }, user);
  const broken = await connectAndRefresh(request, 'tc64k', { defaultPolicy: 'ALLOW', name: uniq('Kaputt TC64') }, user);
  const neverTenant = newTenant('tc64n');
  const never = await createUpstream(request, user, { url: fakeMcpUrl(neverTenant), name: uniq('Nie verbunden TC64') });
  const { accessToken: token } = await runOAuthFlow(request, uniq('Client tc64'), user);

  // needs reconnect: access token dead, refresh rejected
  await fakeControl(request, needsReconnect.tenant, 'expire-access');
  await fakeControl(request, needsReconnect.tenant, 'config', { rejectRefresh: true });
  // unreachable/misbehaving: the MCP endpoint redirects (never followed)
  await fakeMalice(request, broken.tenant, { redirectMcp: true });
  const before = {
    reconnect: (await fakeState(request, needsReconnect.tenant)).mcpRequests,
    broken: (await fakeState(request, broken.tenant)).mcpRequests,
  };

  const res = await postUnified(request, token, LIST);
  expect(res.status()).toBe(200);
  const names = ((await parseRpc(res)).result.tools as { name: string }[]).map((t) => t.name).sort();
  expect(names).toEqual(['add_item', 'delete_all', 'list_items'].map((n) => `${good.slug}_${n}`).sort());
  // the failing ones really were tried, the never-connected one was not contacted
  expect((await fakeState(request, needsReconnect.tenant)).mcpRequests + (await fakeState(request, needsReconnect.tenant)).refreshCount).toBeGreaterThan(before.reconnect);
  expect((await fakeState(request, broken.tenant)).mcpRequests).toBeGreaterThan(before.broken);
  const never_ = await fakeState(request, neverTenant);
  expect(never_.mcpRequests).toBe(0);
  expect(never_.authSeen).toEqual([]);

  // initialize still answers; the not-connected upstream gets its one-line note
  const init = await mcp(request, null, token, 'initialize', INITIALIZE.params);
  const text: string = init.result.instructions;
  expect(sections(text).some((l) => l.includes(never.name) && l.includes(`${never.slug}_`))).toBe(true);
  expect(text).toMatch(new RegExp(`## ${never.name}[^]*?nicht verbunden`));
  expect(sections(text).some((l) => l.includes(good.name))).toBe(true);
  expect((await fakeState(request, neverTenant)).mcpRequests).toBe(0);
  // the healthy one is still callable
  expect((await callTool(request, null, token, `${good.slug}_list_items`)).isError).toBeFalsy();
});

test('TC-65 Auth: ohne Token 401 + Metadaten (resource=<origin>/mcp); Upstream-Token und MCP_TOKEN 401; Nutzer ohne Upstreams: leer, nur Präfix', async ({ request }) => {
  const { ua, token } = await twoUpstreams(request, 'tc65');

  // no token: challenge pointing at the unified resource document
  const anon = await postUnified(request, null, LIST);
  expect(anon.status()).toBe(401);
  const challenge = anon.headers()['www-authenticate'] ?? '';
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  expect(metadataUrl, challenge).toBeTruthy();
  const doc = await request.get(metadataUrl!);
  expect(doc.status()).toBe(200);
  expect((await doc.json()).resource).toBe(`${BASE_URL}/mcp`);

  // a per-upstream access token: valid on /mcp/<ua>, but a 401 challenge on /mcp
  const created = await request.post(`/api/upstreams/${ua.id}/tokens`, { headers: UNI_A, data: { name: uniq('Token TC65') } });
  expect(created.status()).toBe(201);
  const { token: xitl } = await created.json();
  expect(xitl).toMatch(/^xitl_/);
  expect((await postMcp(request, ua.slug, xitl, LIST)).status()).toBe(200);
  const refused = await postUnified(request, xitl, LIST);
  expect(refused.status()).toBe(401);
  expect(refused.headers()['www-authenticate']).toContain('resource_metadata=');
  expect((await postUnified(request, xitl, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: `${ua.slug}_list_items`, arguments: {} } })).status()).toBe(401);
  expect((await postUnified(request, MCP_TOKEN, LIST)).status()).toBe(401);
  expect((await postUnified(request, 'garbage', LIST)).status()).toBe(401);
  expect((await fakeState(request, ua.tenant)).calls.list_items ?? 0).toBe(0);

  // a user without upstreams: empty list, prefix-only instructions, nothing of anyone else's
  const empty = await runOAuthFlow(request, uniq('Client tc65 leer'), UNI_EMPTY);
  expect(await listTools(request, null, empty.accessToken)).toEqual([]);
  const init = await mcp(request, null, empty.accessToken, 'initialize', INITIALIZE.params);
  const text: string = init.result.instructions;
  expect(text.startsWith('Über xitl vermittelt')).toBe(true);
  expect(sections(text)).toEqual([]);
  expect(text).not.toContain(ua.slug);
  expect(text).not.toContain(ua.name);
  // and still cannot call someone else's tool by its name
  const stolen = await callTool(request, null, empty.accessToken, `${ua.slug}_list_items`);
  expect(stolen.isError).toBe(true);
  expect((await fakeState(request, ua.tenant)).calls.list_items ?? 0).toBe(0);
  // while the first user's own list does contain it (control)
  expect((await listTools(request, null, token)).some((t) => t.name === `${ua.slug}_list_items`)).toBe(true);
});

test.describe('Sitzungen und Einstellungen im Browser', () => {
  test.use({ extraHTTPHeaders: UNI_A });

  test('TC-66 Sitzung auf /mcp: ohne Upstream, Aufrufe tragen sie, Id nicht auf /mcp/<slug> (404) und umgekehrt, DELETE beendet, Liste "Alle Upstreams"', async ({ page, request }) => {
    const { ua, token } = await twoUpstreams(request, 'tc66');
    const s = await openUnifiedSession(request, token, { clientInfo: { name: 'claude-ai', version: '0.1.0' } });
    expect(s.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = () => dbAll('select * from McpSession where id = ?', s.sessionId)[0];
    expect(row()).toMatchObject({ userId: userId(UNI_A), upstreamId: null, clientName: 'claude-ai', callCount: 0, endedAt: null });

    const call = await s.rpc('tools/call', { name: `${ua.slug}_list_items`, arguments: {} });
    expect(call.result.content[0].text).toBe('Milch, Brot');
    expect(dbAll("select * from AuditEntry where sessionId = ? and endpoint = '/mcp'", s.sessionId)).toHaveLength(1);
    expect(row().callCount).toBe(1);
    expect((await s.rpc('tools/list')).result.tools.length).toBeGreaterThan(0);

    // sessions are not interchangeable between the endpoints
    const single = await openMcpSession(request, ua.slug, token);
    const wrong1 = await postMcp(request, ua.slug, token, LIST, { sessionId: s.sessionId });
    expect(wrong1.status()).toBe(404);
    const wrong2 = await postUnified(request, token, LIST, { sessionId: single.sessionId });
    expect(wrong2.status()).toBe(404);
    expect((await postUnified(request, token, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: `${ua.slug}_list_items`, arguments: {} } }, { sessionId: single.sessionId })).status()).toBe(404);
    expect((await fakeState(request, ua.tenant)).calls.list_items).toBe(1); // the one legit call only
    expect(row().endedAt).toBeNull();

    // the Sitzungen list shows it as "Alle Upstreams"
    await page.goto('/#/sitzungen');
    const listRow = page.locator(`a.history-link[data-session="${s.sessionId}"]`);
    await expect(listRow).toContainText('Alle Upstreams');
    await expect(listRow).toContainText('claude-ai 0.1.0');
    await listRow.click();
    await expect(page.getByRole('article', { name: 'Sitzung' })).toContainText('Alle Upstreams');

    // DELETE ends it; afterwards 404
    const del = await deleteUnified(request, token, { sessionId: s.sessionId, headers: { 'MCP-Protocol-Version': '2025-06-18' } });
    expect([200, 202, 204]).toContain(del.status());
    expect(row().endedAt).not.toBeNull();
    expect((await postUnified(request, token, LIST, { sessionId: s.sessionId })).status()).toBe(404);
    expect((await deleteUnified(request, token, { sessionId: s.sessionId })).status()).toBe(404);
    expect(row().callCount).toBe(1);
  });

  test('TC-68 Einstellungen @390x844: Adresse für alle Upstreams mit Kopieren oberhalb der Upstream-Liste, Hinweis OAuth statt Tokens, kein horizontales Scrollen', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL }).catch(() => undefined);
    const ua = await createUpstream(request, UNI_A, { slug: uniqSlug('tc68'), name: uniq('Haushalt TC68') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/einstellungen');

    const box = page.getByRole('textbox', { name: 'MCP-Adresse für alle Upstreams' });
    await expect(box).toHaveValue(`${BASE_URL}/mcp`);
    const copy = page.getByRole('button', { name: 'Adresse für alle Upstreams kopieren' });
    await expect(copy).toBeVisible();
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // above the upstream list
    const item = page.locator(`li.item[data-slug="${ua.slug}"]`);
    await expect(item).toBeVisible();
    expect((await box.boundingBox())!.y).toBeLessThan((await item.boundingBox())!.y);

    // the note: all upstreams, Claude login (OAuth), not per-upstream tokens
    const card = page.locator('.unified');
    await expect(card).toContainText(/alle Upstreams/i);
    await expect(card).toContainText(/Claude-Anmeldung/);
    await expect(card).toContainText(/nicht mit\s+Upstream-Tokens/);

    await copy.click();
    await expect(page.getByRole('button', { name: 'Adresse für alle Upstreams kopieren' })).toHaveText('Kopiert');
    expect(await page.evaluate(() => navigator.clipboard.readText()).catch(() => `${BASE_URL}/mcp`)).toBe(`${BASE_URL}/mcp`);

    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });
});

test('TC-67 Upstream löschen während ein /mcp-Aufruf wartet: sofort abgelehnt (+revoked); danach sind ub_*-Namen unbekannt', async ({ request }) => {
  const user = UNI_A;
  const ua = await connectAndRefresh(request, 'tc67a', { defaultPolicy: 'ALLOW', name: uniq('Bleibt TC67') }, user);
  const ub = await connectAndRefresh(request, 'tc67b', { defaultPolicy: 'ASK', name: uniq('Wird gelöscht TC67') }, user);
  const { accessToken: token } = await runOAuthFlow(request, uniq('Client tc67'), user);
  expect((await listTools(request, null, token)).map((t) => t.name)).toContain(`${ub.slug}_add_item`);

  const held = callTool(request, null, token, `${ub.slug}_add_item`, { item: 'nach Löschen' });
  const p = await waitPending(request, ub.id, 'add_item', user);
  const t0 = Date.now();
  expect((await request.delete(`/api/upstreams/${ub.id}`, { headers: user })).status()).toBe(204);
  const result = await held;
  expect(Date.now() - t0).toBeLessThan(2500); // at once, not at the 5 s timeout
  expect(result.isError).toBe(true);
  const audit = dbAll('select * from AuditEntry where approvalId = ?', p.id)[0];
  expect(audit).toMatchObject({ outcome: 'DENIED', endpoint: '/mcp', toolName: 'add_item' });
  expect(audit.decisionPath).toMatch(/\+revoked$/);
  expect((await decide(request, p.id, { decision: 'approve' }, user)).status()).toBe(409);
  expect((await fakeState(request, ub.tenant)).calls.add_item ?? 0).toBe(0);

  // afterwards the name is simply unknown, and the other upstream is unaffected
  const names = (await listTools(request, null, token)).map((t) => t.name);
  expect(names.filter((n) => n.startsWith(`${ub.slug}_`))).toEqual([]);
  expect(names).toContain(`${ua.slug}_list_items`);
  const base = maxAuditId();
  for (const name of [`${ub.slug}_add_item`, `${ub.slug}_list_items`]) {
    const r = await callTool(request, null, token, name);
    expect(r.isError, name).toBe(true);
    expect(r.content[0]!.text, name).toContain('nicht bekannt');
  }
  const rows = auditRows(userId(user), base);
  expect(rows).toHaveLength(2);
  rows.forEach((row) => expect(row).toMatchObject({ outcome: 'DENIED', decisionPath: 'unknown-tool', upstreamId: null }));
  expect((await fakeState(request, ub.tenant)).calls).toEqual({});
  expect((await callTool(request, null, token, `${ua.slug}_list_items`)).isError).toBeFalsy();
});
