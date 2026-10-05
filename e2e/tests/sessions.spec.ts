// MCP sessions (ADR-0016): TC-55…TC-60. Pure helpers (ids, header/meta
// extraction, caps) are unit tests in apps/api/src/mcp/sessions.test.ts.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ANNA, MATTHIAS, createUpstream, dbAll, dbRun, uniq } from '../support/db.js';
import { deleteMcp, openMcpSession, parseRpc, postMcp, runOAuthFlow, LIST, INITIALIZE } from '../support/mcpClient.js';
import { fakeState } from '../support/upstream.js';
import { askUpstream, decide, lastAudit, waitPending } from '../support/approval.js';
import { BASE_URL, DATABASE_URL, MCP_TOKEN, ROOT, SERVER_ENTRY, WEB_DIST } from '../support/paths.js';

test.use({ extraHTTPHeaders: {} });

const sessionRow = (id: string) => dbAll('select * from McpSession where id = ?', id)[0];
const userId = (username: string) => dbAll('select id from User where username = ?', username)[0].id as number;
const clientRowId = (clientId: string) => dbAll('select id from McpClient where clientId = ?', clientId)[0].id as number;
const notFoundBody = { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' } };

/** An ALLOW upstream (tools acknowledged) with one OAuth client of `user`. */
const allowUpstream = (request: APIRequestContext, prefix: string, user = MATTHIAS) => askUpstream(request, prefix, { defaultPolicy: 'ALLOW' }, user);

/** anna's upstream, NOT connected (upstream-connect.spec.ts TC-16 expects anna
 * to hold no upstream tokens), with one OAuth client: enough for a session. */
async function annaUpstream(request: APIRequestContext) {
  const up = await createUpstream(request, ANNA);
  const client = await runOAuthFlow(request, uniq('Client anna'), ANNA);
  return { up, token: client.accessToken };
}

test('TC-55 initialize liefert Mcp-Session-Id; die Sitzung speichert Nutzer, Client, Upstream, clientInfo, Protokoll, User-Agent', async ({ request }) => {
  const { up, token, clientId } = await allowUpstream(request, 'tc55');
  const s = await openMcpSession(request, up.slug, token, {
    clientInfo: { name: 'claude-ai', version: '0.1.0' },
    protocolVersion: '2025-06-18',
    headers: { 'User-Agent': 'Claude-User/1.0 (e2e)' },
  });
  expect(s.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(s.initResult.result.serverInfo.name).toBe(`xitl/${up.slug}`);
  const row = sessionRow(s.sessionId);
  expect(row).toMatchObject({
    userId: userId('matthias'),
    mcpClientId: clientRowId(clientId),
    upstreamId: up.id,
    clientName: 'claude-ai',
    clientVersion: '0.1.0',
    protocolVersion: '2025-06-18',
    userAgent: 'Claude-User/1.0 (e2e)',
    callCount: 0,
    endedAt: null,
  });
  expect(row.createdAt).toBeTruthy();
  expect(row.lastSeenAt).toBe(row.createdAt);

  // Every initialize is a new session.
  const again = await openMcpSession(request, up.slug, token);
  expect(again.sessionId).not.toBe(s.sessionId);
  // An initialize carrying an old session id still gets a fresh one (spec).
  const res = await postMcp(request, up.slug, token, INITIALIZE, { sessionId: s.sessionId });
  expect(res.status()).toBe(200);
  const third = res.headers()['mcp-session-id'];
  expect(third).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(third).not.toBe(s.sessionId);

  // Per-upstream access tokens (ADR-0015) get sessions too.
  const created = await request.post(`/api/upstreams/${up.id}/tokens`, { headers: MATTHIAS, data: { name: uniq('Token TC55') } });
  expect(created.status()).toBe(201);
  const { token: accessToken, client } = await created.json();
  const t = await openMcpSession(request, up.slug, accessToken);
  expect(sessionRow(t.sessionId)).toMatchObject({ mcpClientId: client.id, upstreamId: up.id });
});

test('TC-55/57 mit dem echten SDK-Client: 2025-Handshake hält die Sitzung und beendet sie; 2026-Aushandlung bleibt ohne Sitzung', async ({ request }) => {
  const { up, token } = await allowUpstream(request, 'tc55sdk');
  const url = new URL(`${BASE_URL}/mcp/${up.slug}`);
  const requestInit = { headers: { Authorization: `Bearer ${token}` } };

  // Default (legacy) negotiation = what 2025-era clients do: initialize, keep the id.
  const legacyTransport = new StreamableHTTPClientTransport(url, { requestInit });
  const legacy = new Client({ name: 'sdk-legacy', version: '9.9.9' });
  await legacy.connect(legacyTransport);
  const sessionId = legacyTransport.sessionId!;
  expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const result = await legacy.callTool({ name: 'list_items', arguments: {} });
  expect(result.content).toEqual([{ type: 'text', text: 'Milch, Brot' }]);
  expect(sessionRow(sessionId)).toMatchObject({ clientName: 'sdk-legacy', clientVersion: '9.9.9', callCount: 1 });
  expect(lastAudit(up.id).sessionId).toBe(sessionId);
  await legacyTransport.terminateSession();
  expect(sessionRow(sessionId).endedAt).toBeTruthy();
  await legacy.close();

  // 'auto' negotiation probes server/discover and speaks 2026-07-28: no sessions.
  const before = dbAll('select count(*) n from McpSession where upstreamId = ?', up.id)[0].n;
  const modernTransport = new StreamableHTTPClientTransport(url, { requestInit });
  const modern = new Client({ name: 'sdk-modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await modern.connect(modernTransport);
  expect(modernTransport.sessionId).toBeUndefined();
  const r2 = await modern.callTool({ name: 'list_items', arguments: {} });
  expect(r2.content).toEqual([{ type: 'text', text: 'Milch, Brot' }]);
  expect(lastAudit(up.id).sessionId).toBeNull();
  expect(dbAll('select count(*) n from McpSession where upstreamId = ?', up.id)[0].n).toBe(before);
  await modern.close();
});

test('TC-57 ohne Sitzungs-Id unverändert; fremde, beendete, unbekannte Id -> 404; ohne Token 401; 2026-Clients ohne Sitzung', async ({ request }) => {
  const mine = await allowUpstream(request, 'tc57');

  // Sessionless: works as before, rows carry no session.
  const init = await postMcp(request, mine.up.slug, mine.token, INITIALIZE);
  expect(init.status()).toBe(200); // the id it gets back is simply ignored
  expect((await postMcp(request, mine.up.slug, mine.token, LIST)).status()).toBe(200);
  const call = await postMcp(request, mine.up.slug, mine.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_items', arguments: {} } });
  expect(call.status()).toBe(200);
  expect((await parseRpc(call)).result.content[0].text).toBe('Milch, Brot');
  expect(lastAudit(mine.up.id)).toMatchObject({ outcome: 'FORWARDED', sessionId: null });

  // Sessions that are not this caller's: another user's, another client's of
  // the same user, another upstream's of the same client, unknown, malformed.
  const annas = await annaUpstream(request);
  const annaSession = await openMcpSession(request, annas.up.slug, annas.token);
  const otherClient = await runOAuthFlow(request, uniq('Client tc57 zwei'), MATTHIAS);
  const otherClientSession = await openMcpSession(request, mine.up.slug, otherClient.accessToken);
  const second = await allowUpstream(request, 'tc57b');
  const otherUpstreamSession = await openMcpSession(request, second.up.slug, mine.token); // same OAuth client, other upstream
  const before = [annaSession, otherClientSession, otherUpstreamSession].map((s) => sessionRow(s.sessionId));
  const callsBefore = (await fakeState(request, mine.up.tenant)).calls.list_items ?? 0;

  for (const foreign of [annaSession.sessionId, otherClientSession.sessionId, otherUpstreamSession.sessionId, 'A'.repeat(43), 'kaputt']) {
    for (const body of [LIST, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_items', arguments: {} } }]) {
      const res = await postMcp(request, mine.up.slug, mine.token, body, { sessionId: foreign });
      expect(res.status(), `session ${foreign}`).toBe(404);
      expect(await res.json()).toMatchObject(notFoundBody);
    }
    expect((await deleteMcp(request, mine.up.slug, mine.token, { sessionId: foreign })).status()).toBe(404);
  }
  // Nothing forwarded, nothing attributed, nothing ended.
  expect((await fakeState(request, mine.up.tenant)).calls.list_items ?? 0).toBe(callsBefore);
  expect([annaSession, otherClientSession, otherUpstreamSession].map((s) => sessionRow(s.sessionId))).toEqual(before);
  expect(dbAll('select count(*) n from AuditEntry where sessionId in (?, ?, ?)', ...before.map((r) => r.id))[0].n).toBe(0);

  // The JSON-RPC id is echoed like the SDK does.
  const echoed = await postMcp(request, mine.up.slug, mine.token, { ...LIST, id: 77 }, { sessionId: 'A'.repeat(43) });
  expect((await echoed.json()).id).toBe(77);

  // The session id is not a credential: without a valid token -> 401.
  const own = await openMcpSession(request, mine.up.slug, mine.token);
  for (const bearer of [null, 'garbage']) {
    const res = await postMcp(request, mine.up.slug, bearer, LIST, { sessionId: own.sessionId });
    expect(res.status()).toBe(401);
  }
  expect((await deleteMcp(request, mine.up.slug, null, { sessionId: own.sessionId })).status()).toBe(401);
  expect(sessionRow(own.sessionId).endedAt).toBeNull();

  // 2026-07-28 era: no initialize, no sessions; served sessionless.
  const discover = await postMcp(
    request,
    mine.up.slug,
    mine.token,
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'modern-e2e', version: '1' },
        },
      },
    },
    { headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' } },
  );
  expect(discover.status()).toBe(200);
  expect(discover.headers()['mcp-session-id']).toBeUndefined();
  expect((await parseRpc(discover)).result).toBeTruthy();
});

test('TC-58 DELETE beendet die Sitzung; danach 404. Sitzungen überleben einen Neustart (gespeichert)', async ({ request }) => {
  const { up, token } = await allowUpstream(request, 'tc58');
  const s = await openMcpSession(request, up.slug, token);

  // Restart survival: a second, freshly started server process on the same DB
  // knows nothing in memory and still accepts the session.
  const port = 3203;
  const proc = spawn('node', [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL, PORT: String(port), WEB_DIST, MCP_TOKEN },
    stdio: 'ignore',
  });
  try {
    await expect
      .poll(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.status ?? 0, { timeout: 15_000 })
      .toBe(200);
    const res = await fetch(`http://127.0.0.1:${port}/mcp/${up.slug}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': s.sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_items', arguments: {} } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Milch, Brot'); // the handler runs while the body streams
    expect(sessionRow(s.sessionId).callCount).toBe(1);
    expect(lastAudit(up.id).sessionId).toBe(s.sessionId);
  } finally {
    proc.kill('SIGTERM');
  }

  // DELETE without a session: nothing to end (the SDK's stateless 405).
  expect((await deleteMcp(request, up.slug, token)).status()).toBe(405);

  const del = await s.end();
  expect(del.status()).toBe(200);
  const row = sessionRow(s.sessionId);
  expect(row.endedAt).toBeTruthy();
  const later = await s.post(LIST);
  expect(later.status()).toBe(404);
  expect(await later.json()).toMatchObject(notFoundBody);
  expect((await s.end()).status()).toBe(404);
  // A fresh initialize starts over.
  const fresh = await openMcpSession(request, up.slug, token);
  expect((await fresh.rpc('tools/list')).result.tools.length).toBeGreaterThan(0);
});

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: MATTHIAS });

  test('TC-56 Anfragen mit Sitzung: lastSeenAt läuft, Audit und Freigabe tragen die Sitzung; Karte und Verlauf zeigen sie', async ({ page, request }) => {
    const { up, token, clientName } = await askUpstream(request, 'tc56', { name: uniq('Einkauf TC56') });
    const s = await openMcpSession(request, up.slug, token);

    // lastSeenAt moves (throttled: only after a minute without anything else to write)
    dbRun('update McpSession set lastSeenAt = ? where id = ?', '2026-01-01T00:00:00.000+00:00', s.sessionId);
    await s.rpc('tools/list');
    expect(Date.parse(sessionRow(s.sessionId).lastSeenAt)).toBeGreaterThan(Date.parse('2026-01-02T00:00:00Z'));

    // A held (ASK) call: the pending call and the card carry the session.
    await page.goto('/');
    const call = s.rpc('tools/call', { name: 'add_item', arguments: { item: 'Eier' } });
    const pending = await waitPending(request, up.id, 'add_item');
    expect(pending).toMatchObject({ session: { id: s.sessionId } });
    const createdAt = Date.parse(sessionRow(s.sessionId).createdAt);
    expect(Date.parse((pending as unknown as { session: { createdAt: string } }).session.createdAt)).toBe(createdAt);

    const card = page.locator('article.approval', { hasText: clientName });
    await expect(card).toBeVisible();
    const hhmm = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(createdAt));
    const line = card.locator('a.session-line');
    await expect(line).toHaveText(`Sitzung seit ${hhmm}`);
    expect((await line.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    expect((await decide(request, pending.id, { decision: 'approve' })).status()).toBe(200);
    expect((await call).result.content[0].text).toBe('hinzugefügt: Eier');
    const audit = lastAudit(up.id);
    expect(audit).toMatchObject({ outcome: 'FORWARDED', sessionId: s.sessionId });
    expect(sessionRow(s.sessionId).callCount).toBe(1);

    // Resolved approval view and the audit API name the session.
    const resolved = await (await request.get(`/api/approvals/${pending.id}`, { headers: MATTHIAS })).json();
    expect(resolved.session).toEqual({ id: s.sessionId, createdAt: new Date(createdAt).toISOString() });
    const detail = await (await request.get(`/api/audit/${audit.id}`, { headers: MATTHIAS })).json();
    expect(detail.session.id).toBe(s.sessionId);

    // Verlauf: the call's group (one per session, ADR-0019) shows the session
    // line as a link; the call detail links to the session too.
    await page.goto('/#/verlauf');
    const group = page.locator('.call-group', { has: page.locator(`a.history-link[data-audit="${audit.id}"]`) });
    await expect(group.locator('a.session-line')).toHaveText(`Sitzung seit ${hhmm}`);
    await group.locator(`a.history-link[data-audit="${audit.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#/verlauf/${audit.id}$`));
    await page.locator('.audit-detail a.session-line').click();
    await expect(page).toHaveURL(new RegExp(`#/sitzungen/${s.sessionId}$`));
    await expect(page.getByLabel('Aufrufe in dieser Sitzung')).toContainText('add_item');
  });

  test('TC-59 Einstellungen -> Sitzungen: eigene, neueste zuerst; Detail mit Aufrufen; anna sieht sie nicht', async ({ page, request }) => {
    const { up, token, clientName } = await allowUpstream(request, 'tc59');
    const older = await openMcpSession(request, up.slug, token, { clientInfo: { name: 'claude-code', version: '2.1.0' }, protocolVersion: '2025-03-26' });
    await older.rpc('tools/call', { name: 'list_items', arguments: {} });
    const newer = await openMcpSession(request, up.slug, token, { clientInfo: { name: 'claude-ai', version: '0.1.0' }, protocolVersion: '2025-06-18' });
    await newer.rpc('tools/call', { name: 'list_items', arguments: { a: 1 } });
    await newer.rpc('tools/call', { name: 'list_items', arguments: { a: 2 } });
    const annas = await annaUpstream(request);
    const annaSession = await openMcpSession(request, annas.up.slug, annas.token);

    // API: own only, newest first; anna's is a 404 for matthias and vice versa.
    const list = (await (await request.get('/api/sessions', { headers: MATTHIAS })).json()).sessions as { id: string }[];
    const ids = list.map((x) => x.id);
    expect(ids).not.toContain(annaSession.sessionId);
    expect(ids.indexOf(newer.sessionId)).toBeLessThan(ids.indexOf(older.sessionId));
    expect((await request.get(`/api/sessions/${annaSession.sessionId}`, { headers: MATTHIAS })).status()).toBe(404);
    expect((await request.get(`/api/sessions/${newer.sessionId}`, { headers: ANNA })).status()).toBe(404);
    const annaList = (await (await request.get('/api/sessions', { headers: ANNA })).json()).sessions as { id: string }[];
    expect(annaList.map((x) => x.id)).not.toContain(newer.sessionId);
    expect((await request.get('/api/sessions/kaputt', { headers: MATTHIAS })).status()).toBe(404);
    expect(await (await request.get(`/api/sessions?before=${annaSession.sessionId}`, { headers: MATTHIAS })).json()).toEqual({ sessions: [], nextBefore: null });

    await page.goto('/#/einstellungen');
    const open = page.getByRole('link', { name: 'Sitzungen ansehen' });
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.click();
    await expect(page).toHaveURL(/#\/sitzungen$/);
    const rows = page.locator('a.history-link[data-session]');
    await expect(rows.first()).toBeVisible();
    const shown = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-session')));
    expect(shown).not.toContain(annaSession.sessionId);
    expect(shown.indexOf(newer.sessionId)).toBeLessThan(shown.indexOf(older.sessionId));
    const row = page.locator(`a.history-link[data-session="${newer.sessionId}"]`);
    await expect(row).toContainText(clientName);
    await expect(row).toContainText(up.name);
    await expect(row).toContainText('claude-ai 0.1.0');
    await expect(row).toContainText('2 Aufrufe');
    await expect(row).toContainText('Protokoll 2025-06-18');
    await expect(row).toContainText('seit');
    await expect(row).toContainText('zuletzt');
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/sitzungen/${newer.sessionId}$`));
    const calls = page.getByLabel('Aufrufe in dieser Sitzung').locator('li');
    await expect(calls).toHaveCount(2);
    await expect(calls.first()).toContainText('list_items');
    await expect(page.getByRole('article', { name: 'Sitzung' })).toContainText('claude-ai 0.1.0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test('TC-60 Diagnose: Header-Namen und _meta-Schlüssel, nie Werte, nie Authorization-Wert', async ({ page, request }) => {
    const { up, token } = await allowUpstream(request, 'tc60');
    const s = await openMcpSession(request, up.slug, token, { headers: { 'User-Agent': 'Claude-User (diag)', 'X-Diag-Probe': 'header-value-geheim' } });
    await s.rpc('tools/call', { name: 'list_items', arguments: {}, _meta: { 'claudeai/conversation': 'meta-value-geheim', progressToken: 'p-geheim' } }, { Cookie: 'sid=cookie-value-geheim', 'X-Later': 'later-value-geheim' });

    const row = sessionRow(s.sessionId);
    const names = JSON.parse(row.headerNames) as string[];
    for (const n of ['authorization', 'user-agent', 'x-diag-probe', 'mcp-session-id', 'mcp-protocol-version', 'cookie', 'x-later']) expect(names).toContain(n);
    expect(JSON.parse(row.metaKeys)).toEqual(['claudeai/conversation', 'progressToken']);
    expect(row.userAgent).toBe('Claude-User (diag)');
    expect(row.protocolVersion).toBe('2025-06-18');
    const everything = JSON.stringify(dbAll('select * from McpSession where id = ?', s.sessionId));
    for (const secret of ['geheim', token]) expect(everything).not.toContain(secret);

    const detail = await (await request.get(`/api/sessions/${s.sessionId}`, { headers: MATTHIAS })).json();
    expect(detail.headerNames).toEqual(names);
    expect(detail.metaKeys).toEqual(['claudeai/conversation', 'progressToken']);
    const body = JSON.stringify(detail);
    for (const secret of ['geheim', token]) expect(body).not.toContain(secret);

    await page.goto(`/#/sitzungen/${s.sessionId}`);
    const diag = page.getByLabel('Diagnose');
    await expect(diag).toContainText('Claude-User (diag)');
    await expect(diag.getByLabel('Header-Namen')).toContainText('x-diag-probe');
    await expect(diag.getByLabel('_meta-Schlüssel')).toContainText('claudeai/conversation');
    await expect(diag).not.toContainText('geheim');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });
});

/** POSTs a JSON-RPC body with `Transfer-Encoding: chunked` (no Content-Length),
 * as clients behind HTTP/2 ingresses arrive. */
function postChunked(path: string, token: string, body: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
    });
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    const json = JSON.stringify(body);
    // Two chunks, so the body really arrives without a declared length.
    req.write(json.slice(0, 10));
    req.end(json.slice(10));
  });
}

test('TC-73 initialize ohne Content-Length (chunked) bekommt trotzdem eine Sitzung', async ({ request }) => {
  const { up, token } = await allowUpstream(request, 'tc73');
  const res = await postChunked(`/mcp/${up.slug}`, token, {
    ...INITIALIZE,
    params: { ...INITIALIZE.params, clientInfo: { name: 'chunked-client', version: '9' } },
  });
  expect(res.status).toBe(200);
  const id = res.headers['mcp-session-id'];
  expect(typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id)).toBe(true);
  expect(sessionRow(id as string)).toMatchObject({ upstreamId: up.id, clientName: 'chunked-client' });
});

test('TC-74 Diagnose je Aufruf auch ohne Sitzung: Protokoll, clientInfo aus _meta, User-Agent, nur Namen von Headern und _meta', async ({ request }) => {
  const { up, token } = await allowUpstream(request, 'tc74');
  const res = await postMcp(
    request,
    up.slug,
    token,
    {
      jsonrpc: '2.0',
      id: 74,
      method: 'tools/call',
      params: {
        name: 'list_items',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '2.0' },
          'example/conversationId': 'conv-secret-value',
        },
      },
    },
    {
      headers: {
        'User-Agent': 'Claude-User/2.0 (e2e)',
        'MCP-Protocol-Version': '2025-11-25',
        'X-Chat-Hint': 'header-secret-value',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'X-Cloud-Trace-Context': '105445aa7843bc8bf206b12000100000/1;o=1',
        'X-Anthropic-Client': 'ClaudeAI',
      },
    },
  );
  expect(res.status()).toBe(200);
  expect((await parseRpc(res)).result.isError ?? false).toBe(false);
  const row = dbAll('select * from AuditEntry where userId = ? order by id desc limit 1', userId('matthias'))[0];
  expect(row).toMatchObject({
    sessionId: null,
    protocolVersion: '2025-11-25',
    clientInfo: 'claude-ai 2.0',
    userAgent: 'Claude-User/2.0 (e2e)',
    // grouping candidates: trace parts only (no span ids), the client token
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    cloudTraceId: '105445aa7843bc8bf206b12000100000',
    anthropicClient: 'ClaudeAI',
  });
  expect(JSON.stringify(row)).not.toContain('00f067aa0ba902b7');
  expect(JSON.parse(row.headerNames)).toEqual(expect.arrayContaining(['authorization', 'x-chat-hint', 'user-agent']));
  expect(JSON.parse(row.metaKeys)).toEqual(['example/conversationId', 'io.modelcontextprotocol/clientInfo']);
  const stored = JSON.stringify(row);
  for (const secret of ['conv-secret-value', 'header-secret-value', token]) expect(stored).not.toContain(secret);

  // ...and the call detail in Verlauf shows it.
  const detail = await (await request.get(`/api/audit/${row.id}`, { headers: MATTHIAS })).json();
  expect(detail.diagnostics).toMatchObject({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', anthropicClient: 'ClaudeAI', protocolVersion: '2025-11-25', clientInfo: 'claude-ai 2.0', metaKeys: ['example/conversationId', 'io.modelcontextprotocol/clientInfo'] });
});
