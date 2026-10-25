// MCP Apps (ADR-0038 + amendment 2026-10-25): TC-240…251.
// Slice 1 (TC-240…242) now holds for a tool whose view is NOT shown (the
// default): no view reference leaves xitl, a view-only tool is not listed and
// a call to it is unknown. Slices 2–3 (TC-243…251): views are recorded, the
// pages read in the background on sync, a tap in Regeln reads the page now and
// acknowledges exactly that hash, and only then the view is listed and its
// page served (resources/read); a changed page is never served. The fake
// upstream serves pages via /control/…/resources and counts reads per uri.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createUpstream, dbAll, dbRun, uniq } from '../support/db.js';
import { parseRpc, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { FAKE_HEADER_NAME, FAKE_HEADER_SECRET, FAKE_UPSTREAM, TOOLS_FRESH_MS } from '../support/paths.js';
import { callTool, connectedUpstream, fakeControl, fakeState, listTools, mcp, newTenant } from '../support/upstream.js';
import { decide, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type User = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): User => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Apps ${prefix}`,
});
/** MSG.unknownTool (apps/api/src/lib/proxyText.ts), exact. */
const unknownText = (name: string) => `[xitl] Verweigert: Das Tool „${name}“ ist nicht bekannt. / Denied: unknown tool "${name}". List the tools first.`;

const MIME = 'text/html;profile=mcp-app';
const VIEW = 'ui://fake/dashboard.html';
const SOLO = 'ui://fake/solo.html';
const PAGE_META = { ui: { csp: { connectDomains: ['https://api.example'] }, prefersBorder: true } };
const PAGE_V1 = { uri: VIEW, text: '<html>chart v1</html>', _meta: PAGE_META };
const NOT_FOUND = 'Resource not found';

interface Ctx {
  user: User;
  up: { id: number; slug: string; name: string; tenant: string };
  token: string;
  clientId: number;
}

/** An upstream offering a tool with a view (+ the flat key and an unrelated
 * `_meta` key), a view-only tool and a model+app tool on the same page, a
 * tool with its own page (`solo`), and one OAuth client. */
async function setup(request: APIRequestContext, prefix: string, opts: { defaultPolicy?: string; user?: User; pages?: Record<string, unknown>[] } = {}): Promise<Ctx> {
  const user = opts.user ?? freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: opts.defaultPolicy ?? 'ALLOW', name: uniq(`Apps ${prefix}`) }, user, async (tenant) => {
    await fakeControl(request, tenant, 'tools', {
      name: 'show_memory',
      description: 'Memory usage with a chart.',
      _meta: { ui: { resourceUri: VIEW }, 'ui/resourceUri': VIEW, 'example.com/keep': 'yes' },
    });
    await fakeControl(request, tenant, 'tools', {
      name: 'refresh_chart',
      description: 'Called by the chart view only.',
      _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } },
    });
    await fakeControl(request, tenant, 'tools', {
      name: 'both_ways',
      description: 'Model and view.',
      _meta: { ui: { resourceUri: VIEW, visibility: ['model', 'app'] } },
    });
    await fakeControl(request, tenant, 'tools', { name: 'solo', description: 'Own page.', _meta: { ui: { resourceUri: SOLO } } });
    for (const p of opts.pages ?? [PAGE_V1, { uri: SOLO, text: '<html>solo</html>' }]) await fakeControl(request, tenant, 'resources', p);
  });
  const c = await runOAuthFlow(request, uniq(`${prefix} client`), user);
  const clientId = dbAll('select id from McpClient where clientId = ?', c.clientId)[0].id as number;
  return { user, up, token: c.accessToken, clientId };
}

interface UiView {
  uri: string | null;
  state: string;
  enabled: boolean;
  read: boolean;
  sharedWith: string[];
  csp: Record<string, string[]> | null;
  appOnly: boolean;
}
interface ToolRowView {
  id: number;
  name: string;
  path: string;
  isChanged: boolean;
  ui: UiView | null;
}
async function toolsOf(request: APIRequestContext, ctx: Ctx): Promise<ToolRowView[]> {
  const res = await request.get(`/api/upstreams/${ctx.up.id}/tools`, { headers: ctx.user });
  expect(res.status()).toBe(200);
  return (await res.json()).tools;
}
const toolOf = async (request: APIRequestContext, ctx: Ctx, name: string) => (await toolsOf(request, ctx)).find((t) => t.name === name)!;
const refresh = async (request: APIRequestContext, ctx: Ctx) =>
  expect((await request.post(`/api/upstreams/${ctx.up.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(200);
const setUi = async (request: APIRequestContext, ctx: Ctx, name: string, uiEnabled: unknown) =>
  request.patch(`/api/upstreams/${ctx.up.id}/tools/${(await toolOf(request, ctx, name)).id}`, { headers: ctx.user, data: { uiEnabled } });
async function show(request: APIRequestContext, ctx: Ctx, name = 'show_memory') {
  const res = await setUi(request, ctx, name, true);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const pageRow = (ctx: Ctx, uri: string) =>
  dbAll('select contentHash, acknowledgedHash, readAt, csp, lastReadFailed from UiResource where upstreamId = ? and uri = ?', ctx.up.id, uri)[0] as
    | { contentHash: string | null; acknowledgedHash: string | null; readAt: number | null; csp: string | null; lastReadFailed: number }
    | undefined;
async function waitRead(ctx: Ctx, uri: string) {
  await expect.poll(() => pageRow(ctx, uri)?.readAt ?? null, { timeout: 5000 }).not.toBeNull();
  return pageRow(ctx, uri)!;
}
const readsOf = async (request: APIRequestContext, ctx: Ctx) => (await fakeState(request, ctx.up.tenant)).reads ?? {};
const totalReads = async (request: APIRequestContext, ctx: Ctx) => Object.values(await readsOf(request, ctx)).reduce((a, b) => a + b, 0);

let rpcN = 5000;
/** One JSON-RPC request; the parsed message (result or error). */
async function rpc(request: APIRequestContext, slug: string | null, token: string, method: string, params: unknown = {}) {
  const res = await postMcp(request, slug, token, { jsonrpc: '2.0', id: ++rpcN, method, params });
  expect(res.status(), `${method}: ${res.status()}`).toBe(200);
  return parseRpc(res);
}
const readRes = (request: APIRequestContext, slug: string | null, token: string, uri: string) => rpc(request, slug, token, 'resources/read', { uri });
/** The one refusal of resources/read (ADR-0038): the SDK puts -32002 on the
 * wire as -32602 with `data.uri` (resource not found, spec 2026-07-28). */
function expectRefused(msg: { error?: unknown; result?: unknown }, uri: string) {
  expect(msg.result).toBeUndefined();
  expect(msg.error).toEqual({ code: -32602, message: NOT_FOUND, data: { uri } });
}
const unified = (slug: string, uri: string) => `ui://${slug}/${uri.slice('ui://'.length)}`;

test.describe('MCP Apps, nothing shown (TC-240…242, ADR-0038)', () => {
  test('TC-240: tools/list carries no view reference, on /mcp/<slug> and /mcp; other _meta keys stay', async ({ request }) => {
    const ctx = await setup(request, 'apps240');
    for (const [slug, prefix] of [[ctx.up.slug, ''], [null, `${ctx.up.slug}_`]] as const) {
      const tools = (await mcp(request, slug, ctx.token, 'tools/list')).result.tools as { name: string; _meta?: Record<string, unknown> }[];
      const byName = new Map(tools.map((t) => [t.name, t]));
      const showTool = byName.get(`${prefix}show_memory`)!;
      expect(showTool).toBeTruthy();
      expect(showTool._meta).toEqual({ 'example.com/keep': 'yes' });
      const both = byName.get(`${prefix}both_ways`)!;
      expect(both).toBeTruthy();
      expect(both._meta).toBeUndefined();
      expect(JSON.stringify(tools)).not.toContain('ui://');
    }
  });

  test('TC-241: a view-only tool is recorded, but not listed while no view is shown', async ({ request }) => {
    const ctx = await setup(request, 'apps241');
    expect((await listTools(request, ctx.up.slug, ctx.token)).map((t) => t.name)).not.toContain('refresh_chart');
    expect((await listTools(request, null, ctx.token)).map((t) => t.name)).not.toContain(`${ctx.up.slug}_refresh_chart`);
    expect(dbAll('select uiMeta, uiResourceUri from KnownTool where upstreamId = ? and name = ?', ctx.up.id, 'refresh_chart')).toEqual([
      { uiMeta: `{"resourceUri":"${VIEW}","visibility":["app"]}`, uiResourceUri: VIEW },
    ]);
    // Regeln shows it, marked view-only.
    expect((await toolOf(request, ctx, 'refresh_chart')).ui).toMatchObject({ uri: VIEW, appOnly: true });
  });

  test('TC-242: calling a view-only tool is refused as unknown and never forwarded, even with default ALLOW', async ({ request }) => {
    const ctx = await setup(request, 'apps242');
    await listTools(request, ctx.up.slug, ctx.token);
    for (const [slug, name] of [[ctx.up.slug, 'refresh_chart'], [null, `${ctx.up.slug}_refresh_chart`]] as const) {
      const r = await callTool(request, slug, ctx.token, name);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe(unknownText(name));
    }
    expect((await fakeState(request, ctx.up.tenant)).calls.refresh_chart ?? 0).toBe(0);
    expect(dbAll("select decisionPath, outcome from AuditEntry where upstreamId = ? and toolName = 'refresh_chart'", ctx.up.id)).toEqual([
      { decisionPath: 'unknown-tool', outcome: 'DENIED' },
      { decisionPath: 'unknown-tool', outcome: 'DENIED' },
    ]);
    // The tool with a view still works normally (text only).
    const ok = await callTool(request, ctx.up.slug, ctx.token, 'show_memory');
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0]!.text).toBe('ok:show_memory');
  });
});

test.describe('MCP Apps, views per tool (TC-243…250, ADR-0038)', () => {
  test('TC-243: the view reference is recorded; a change of it is a changed tool', async ({ request }) => {
    const ctx = await setup(request, 'apps243');
    await refresh(request, ctx);
    expect(dbAll('select name, uiMeta, uiResourceUri, changedAt from KnownTool where upstreamId = ? and name in (?, ?) order by name', ctx.up.id, 'both_ways', 'show_memory')).toEqual([
      { name: 'both_ways', uiMeta: `{"resourceUri":"${VIEW}","visibility":["model","app"]}`, uiResourceUri: VIEW, changedAt: null },
      { name: 'show_memory', uiMeta: `{"resourceUri":"${VIEW}"}`, uiResourceUri: VIEW, changedAt: null },
    ]);
    // A row recorded before the column (NULL) gets it silently.
    dbRun('update KnownTool set uiMeta = null where upstreamId = ? and name = ?', ctx.up.id, 'solo');
    await refresh(request, ctx);
    expect(dbAll('select uiMeta, changedAt from KnownTool where upstreamId = ? and name = ?', ctx.up.id, 'solo')).toEqual([{ uiMeta: `{"resourceUri":"${SOLO}"}`, changedAt: null }]);
    // The upstream points the tool at another page: changed (ASK), prevUiMeta kept.
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'show_memory', description: 'Memory usage with a chart.', _meta: { ui: { resourceUri: 'ui://fake/other.html' } } });
    await refresh(request, ctx);
    const row = dbAll('select uiMeta, prevUiMeta, uiResourceUri, changedAt, acknowledgedAt from KnownTool where upstreamId = ? and name = ?', ctx.up.id, 'show_memory')[0];
    expect(row).toMatchObject({ uiMeta: '{"resourceUri":"ui://fake/other.html"}', prevUiMeta: `{"resourceUri":"${VIEW}"}`, uiResourceUri: 'ui://fake/other.html', acknowledgedAt: null });
    expect(row.changedAt).not.toBeNull();
    const t = await toolOf(request, ctx, 'show_memory');
    expect(t.isChanged).toBe(true);
    expect(t.path).toBe('changed-tool');
    // Only the visibility changes: a change too.
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'both_ways', description: 'Model and view.', _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } } });
    await refresh(request, ctx);
    expect((await toolOf(request, ctx, 'both_ways')).isChanged).toBe(true);
  });

  test('TC-244: pages are read once in the background on sync; tools/list does not wait; bad pages count as failed', async ({ request }) => {
    const ctx = await setup(request, 'apps244', {
      pages: [
        PAGE_V1,
        { uri: SOLO, text: '<html>solo</html>', delayMs: 3000 },
      ],
    });
    // tools/list answers although one page takes 3 s.
    const t0 = Date.now();
    await listTools(request, ctx.up.slug, ctx.token);
    expect(Date.now() - t0).toBeLessThan(2000);
    const row = await waitRead(ctx, VIEW);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.acknowledgedHash).toBeNull();
    expect(JSON.parse(row.csp!)).toMatchObject({ connectDomains: ['https://api.example'] });
    // One read per page, not per tool (three tools share VIEW).
    expect((await readsOf(request, ctx))[VIEW]).toBe(1);
    // A second sync within the window ("Tools aktualisieren") does not read again.
    await refresh(request, ctx);
    await new Promise((r) => setTimeout(r, 300));
    expect((await readsOf(request, ctx))[VIEW]).toBe(1);
    await waitRead(ctx, SOLO);
    expect((await readsOf(request, ctx))[SOLO]).toBe(1);
    expect((await toolOf(request, ctx, 'show_memory')).ui).toMatchObject({ state: 'new', read: true, sharedWith: ['both_ways', 'refresh_chart'] });

    // Failed and malformed pages: no hash.
    const bad = await setup(request, 'apps244b', {
      pages: [
        { uri: VIEW, text: '<html>x</html>', fail: true },
        { uri: SOLO, text: '<html>x</html>', mimeType: 'text/html' },
      ],
    });
    for (const [name, uri, page] of [
      ['big', 'ui://fake/big.html', { text: 'x', padTo: 2 * 1024 * 1024 + 10 }],
      ['two', 'ui://fake/two.html', { text: '<p>2</p>', extraItem: true }],
    ] as const) {
      await fakeControl(request, bad.up.tenant, 'tools', { name, description: name, _meta: { ui: { resourceUri: uri } } });
      await fakeControl(request, bad.up.tenant, 'resources', { uri, ...page });
    }
    await refresh(request, bad);
    for (const uri of [VIEW, SOLO, 'ui://fake/big.html', 'ui://fake/two.html']) {
      await expect.poll(() => pageRow(bad, uri)?.lastReadFailed ?? null, { timeout: 5000, message: uri }).toBe(1);
      expect(pageRow(bad, uri)!.contentHash, uri).toBeNull();
    }
    expect((await toolOf(request, bad, 'show_memory')).ui?.state).toBe('unreadable');
    // A failed read is not a failed contact: no Störung.
    expect(dbAll('select lastFailureAt from Upstream where id = ?', bad.up.id)[0].lastFailureAt).toBeNull();
  });

  test('TC-245: the tap reads the page now, acknowledges it and shows the view; failures change nothing', async ({ request }) => {
    const ctx = await setup(request, 'apps245');
    await refresh(request, ctx);
    await waitRead(ctx, VIEW);
    const before = (await readsOf(request, ctx))[VIEW]!;
    const view = await show(request, ctx);
    expect((await readsOf(request, ctx))[VIEW]).toBe(before + 1);
    const row = pageRow(ctx, VIEW)!;
    expect(row.acknowledgedHash).toBe(row.contentHash);
    const t = view.tools.find((x: ToolRowView) => x.name === 'show_memory') as ToolRowView;
    expect(t.ui).toEqual({
      uri: VIEW,
      state: 'shown',
      enabled: true,
      read: true,
      sharedWith: ['both_ways', 'refresh_chart'],
      csp: { connectDomains: ['https://api.example'], resourceDomains: [], frameDomains: [], baseUriDomains: [], permissions: [] },
      appOnly: false,
    });
    // Shared page: acknowledged via show_memory, both_ways stays off until its own tap.
    expect((await toolOf(request, ctx, 'both_ways')).ui).toMatchObject({ state: 'off', enabled: false });
    await show(request, ctx, 'both_ways');
    expect((await toolOf(request, ctx, 'both_ways')).ui).toMatchObject({ state: 'shown', enabled: true });
    // Off: the acknowledgement stays.
    const off = await setUi(request, ctx, 'both_ways', false);
    expect(off.status()).toBe(200);
    expect((await toolOf(request, ctx, 'both_ways')).ui).toMatchObject({ state: 'off', enabled: false });
    expect(pageRow(ctx, VIEW)!.acknowledgedHash).toBe(row.contentHash);

    // The read fails: 502 with a German message, nothing changed.
    const ackBefore = pageRow(ctx, SOLO)?.acknowledgedHash ?? null;
    await fakeControl(request, ctx.up.tenant, 'resources', { uri: SOLO, text: 'x', fail: true });
    const failed = await setUi(request, ctx, 'solo', true);
    expect(failed.status()).toBe(502);
    expect((await failed.json()).error).toBe('Die Oberfläche konnte nicht vom Upstream geladen werden. Versuche es später noch einmal.');
    expect(dbAll('select uiEnabled from KnownTool where upstreamId = ? and name = ?', ctx.up.id, 'solo')[0].uiEnabled).toBe(0);
    expect(pageRow(ctx, SOLO)?.acknowledgedHash ?? null).toBe(ackBefore);
    // A tool without a view: 400. Garbage: 400. Another user's tool: 404.
    expect((await setUi(request, ctx, 'list_items', true)).status()).toBe(400);
    expect((await setUi(request, ctx, 'show_memory', 'yes')).status()).toBe(400);
    const tid = (await toolOf(request, ctx, 'show_memory')).id;
    const stranger = freshUser('apps245x');
    expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${tid}`, { headers: stranger, data: { uiEnabled: true } })).status()).toBe(404);
    expect((await request.post(`/api/upstreams/${ctx.up.id}/tools/${tid}/ui/acknowledge`, { headers: stranger })).status()).toBe(404);
    // A paused upstream is not contacted: 409.
    expect((await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { paused: true } })).status()).toBe(200);
    const readsPaused = await totalReads(request, ctx);
    expect((await setUi(request, ctx, 'solo', true)).status()).toBe(409);
    expect(await totalReads(request, ctx)).toBe(readsPaused);
  });

  test('TC-246: tools/list keeps a shown view (rewritten on /mcp); view-only tools only with a shown view', async ({ request }) => {
    const ctx = await setup(request, 'apps246', { defaultPolicy: 'ASK' });
    // initialize advertises resources on both endpoints.
    for (const slug of [ctx.up.slug, null]) {
      const init = await mcp(request, slug, ctx.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      expect(init.result.capabilities.resources).toEqual({});
    }
    await refresh(request, ctx);
    await waitRead(ctx, VIEW);
    // Never acknowledged: stripped, view-only absent.
    let single = await listTools(request, ctx.up.slug, ctx.token);
    expect(JSON.stringify(single)).not.toContain('ui://');
    expect(single.map((t) => t.name)).not.toContain('refresh_chart');

    await show(request, ctx);
    single = await listTools(request, ctx.up.slug, ctx.token);
    const byName = new Map(single.map((t) => [t.name, t as { _meta?: unknown }]));
    expect(byName.get('show_memory')!._meta).toEqual({ ui: { resourceUri: VIEW }, 'ui/resourceUri': VIEW, 'example.com/keep': 'yes' });
    expect(byName.get('refresh_chart')!._meta).toBeUndefined(); // its own switch is off
    expect(byName.has('refresh_chart')).toBe(true);
    expect(byName.get('both_ways')!._meta).toBeUndefined();
    const all = new Map((await listTools(request, null, ctx.token)).map((t) => [t.name, t as { _meta?: unknown }]));
    const rewritten = unified(ctx.up.slug, VIEW);
    expect(all.get(`${ctx.up.slug}_show_memory`)!._meta).toEqual({ ui: { resourceUri: rewritten }, 'ui/resourceUri': rewritten, 'example.com/keep': 'yes' });
    expect(all.has(`${ctx.up.slug}_refresh_chart`)).toBe(true);

    // With a view shown, a call to the view-only tool follows policy: ASK -> held.
    const pending = callTool(request, ctx.up.slug, ctx.token, 'refresh_chart');
    const held = await waitPending(request, ctx.up.id, 'refresh_chart', ctx.user);
    expect((await decide(request, held.id, { decision: 'approve' }, ctx.user)).status()).toBe(200);
    expect((await pending).content[0]!.text).toBe('ok:refresh_chart');

    // Switched off: stripped again, the view-only tool is unknown again.
    expect((await setUi(request, ctx, 'show_memory', false)).status()).toBe(200);
    single = await listTools(request, ctx.up.slug, ctx.token);
    expect(JSON.stringify(single)).not.toContain('ui://');
    expect(single.map((t) => t.name)).not.toContain('refresh_chart');
    const calls = (await fakeState(request, ctx.up.tenant)).calls.refresh_chart ?? 0;
    const r = await callTool(request, null, ctx.token, `${ctx.up.slug}_refresh_chart`);
    expect(r.content[0]!.text).toBe(unknownText(`${ctx.up.slug}_refresh_chart`));
    expect((await fakeState(request, ctx.up.tenant)).calls.refresh_chart ?? 0).toBe(calls);
    // A DENY anchor is no anchor: on again, but show_memory denied for this client.
    await show(request, ctx);
    expect((await listTools(request, ctx.up.slug, ctx.token)).map((t) => t.name)).toContain('refresh_chart');
    const sid = (await toolOf(request, ctx, 'show_memory')).id;
    expect((await request.put(`/api/upstreams/${ctx.up.id}/tools/${sid}/clients/${ctx.clientId}`, { headers: ctx.user, data: { policy: 'DENY' } })).status()).toBe(200);
    const names = (await listTools(request, ctx.up.slug, ctx.token)).map((t) => t.name);
    expect(names).not.toContain('show_memory');
    expect(names).not.toContain('refresh_chart');
  });

  test('TC-247: resources/read serves only shown pages; every refusal is the same and contacts nothing', async ({ request }) => {
    const ctx = await setup(request, 'apps247');
    await fakeControl(request, ctx.up.tenant, 'resources', { uri: 'ui://fake/orphan.html', text: '<p>orphan</p>' });
    await refresh(request, ctx);
    await waitRead(ctx, VIEW);
    await waitRead(ctx, SOLO);
    await show(request, ctx);
    await show(request, ctx, 'solo');

    // Served: original uri on /mcp/<slug>, rewritten on /mcp.
    const served = await readRes(request, ctx.up.slug, ctx.token, VIEW);
    expect(served.result.contents).toEqual([{ uri: VIEW, mimeType: MIME, text: '<html>chart v1</html>', _meta: PAGE_META }]);
    const rw = unified(ctx.up.slug, VIEW);
    expect((await readRes(request, null, ctx.token, rw)).result.contents).toEqual([{ uri: rw, mimeType: MIME, text: '<html>chart v1</html>', _meta: PAGE_META }]);

    const refusedNoContact = async (slug: string | null, uri: string, token = ctx.token) => {
      const before = await totalReads(request, ctx);
      expectRefused(await readRes(request, slug, token, uri), uri);
      expect(await totalReads(request, ctx), uri).toBe(before);
    };
    // Unknown uri; a page the upstream has but no tool references.
    await refusedNoContact(ctx.up.slug, 'ui://fake/nothing.html');
    await refusedNoContact(ctx.up.slug, 'ui://fake/orphan.html');
    await refusedNoContact(null, unified(ctx.up.slug, 'ui://fake/orphan.html'));
    // Bad forms on /mcp.
    for (const bad of ['ui://', `ui://${ctx.up.slug}`, `http://${ctx.up.slug}/fake/dashboard.html`, `ui://${ctx.up.slug.replace('-', '_')}/fake/dashboard.html`, VIEW]) {
      await refusedNoContact(null, bad);
    }
    // The page's only tool switched off.
    expect((await setUi(request, ctx, 'solo', false)).status()).toBe(200);
    await refusedNoContact(ctx.up.slug, SOLO);
    await show(request, ctx, 'solo');
    expect((await readRes(request, ctx.up.slug, ctx.token, SOLO)).result.contents[0].text).toBe('<html>solo</html>');
    // The only referencing tool DENY for this client (client rule, then tool rule).
    const soloId = (await toolOf(request, ctx, 'solo')).id;
    expect((await request.put(`/api/upstreams/${ctx.up.id}/tools/${soloId}/clients/${ctx.clientId}`, { headers: ctx.user, data: { policy: 'DENY' } })).status()).toBe(200);
    await refusedNoContact(ctx.up.slug, SOLO);
    expect((await request.delete(`/api/upstreams/${ctx.up.id}/tools/${soloId}/clients/${ctx.clientId}`, { headers: ctx.user })).status()).toBe(200);
    expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${soloId}`, { headers: ctx.user, data: { policy: 'DENY' } })).status()).toBe(200);
    await refusedNoContact(ctx.up.slug, SOLO);
    await refusedNoContact(null, unified(ctx.up.slug, SOLO));
    // Upstream paused.
    expect((await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { paused: true } })).status()).toBe(200);
    await refusedNoContact(ctx.up.slug, VIEW);
    await refusedNoContact(null, rw);
    expect((await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { paused: false } })).status()).toBe(200);
    // Hidden for this client (ADR-0032).
    expect((await request.put(`/api/upstreams/${ctx.up.id}/clients/${ctx.clientId}`, { headers: ctx.user, data: { policy: 'DENY' } })).status()).toBe(200);
    await refusedNoContact(ctx.up.slug, VIEW);
    await refusedNoContact(null, rw);
    expect((await request.delete(`/api/upstreams/${ctx.up.id}/clients/${ctx.clientId}`, { headers: ctx.user })).status()).toBe(200);
    expect((await readRes(request, ctx.up.slug, ctx.token, VIEW)).result.contents[0].text).toBe('<html>chart v1</html>');

    // Another user: the same slug resolves among HIS upstreams only.
    const other = await runOAuthFlow(request, uniq('apps247 other'), freshUser('apps247o'));
    await refusedNoContact(null, rw, other.accessToken);
    // An access token scoped to another upstream of the same user: its
    // endpoint has no such page, and /mcp is closed to it (401 at the gate).
    const otherUp = await connectedUpstream(request, 'apps247b', { defaultPolicy: 'ALLOW', name: uniq('Apps 247 B') }, ctx.user);
    const tok = await request.post(`/api/upstreams/${otherUp.id}/tokens`, { headers: ctx.user, data: { name: uniq('apps247 token') } });
    expect(tok.status()).toBe(201);
    const scoped = (await tok.json()).token as string;
    await refusedNoContact(otherUp.slug, VIEW, scoped);
    expect((await postMcp(request, null, scoped, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: rw } })).status()).toBe(401);
    expect((await postMcp(request, ctx.up.slug, scoped, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: VIEW } })).status()).toBe(401);
    // Never acknowledged: a fresh tool with its own page.
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'fresh', description: 'Fresh.', _meta: { ui: { resourceUri: 'ui://fake/fresh.html' } } });
    await fakeControl(request, ctx.up.tenant, 'resources', { uri: 'ui://fake/fresh.html', text: '<p>fresh</p>' });
    await new Promise((r) => setTimeout(r, TOOLS_FRESH_MS + 100));
    await refresh(request, ctx);
    await waitRead(ctx, 'ui://fake/fresh.html');
    expect(dbAll("select uiEnabled from KnownTool where upstreamId = ? and name = 'fresh'", ctx.up.id)[0].uiEnabled).toBe(0);
    // The switch alone (no acknowledgement) is not enough.
    dbRun('update KnownTool set uiEnabled = 1 where upstreamId = ? and name = ?', ctx.up.id, 'fresh');
    await refusedNoContact(ctx.up.slug, 'ui://fake/fresh.html');
  });

  test('TC-248: a changed page is not served, counts as changed everywhere, and "Neue Version anzeigen" brings it back', async ({ request }) => {
    const ctx = await setup(request, 'apps248');
    await refresh(request, ctx);
    await waitRead(ctx, VIEW);
    await show(request, ctx);
    const ack1 = pageRow(ctx, VIEW)!.acknowledgedHash;
    expect((await readRes(request, ctx.up.slug, ctx.token, VIEW)).result.contents[0].text).toBe('<html>chart v1</html>');

    // New HTML: the next host read is refused and records the new hash.
    await fakeControl(request, ctx.up.tenant, 'resources', { ...PAGE_V1, text: '<html>chart v2</html>' });
    expectRefused(await readRes(request, ctx.up.slug, ctx.token, VIEW), VIEW);
    const row = pageRow(ctx, VIEW)!;
    expect(row.acknowledgedHash).toBe(ack1);
    expect(row.contentHash).not.toBe(ack1);
    // Stripped from tools/list, the view-only tool gone with it.
    const listed = await listTools(request, ctx.up.slug, ctx.token);
    expect(JSON.stringify(listed)).not.toContain('ui://');
    expect(listed.map((t) => t.name)).not.toContain('refresh_chart');
    // Regeln: changed on every tool using the page; switches as they were.
    for (const name of ['show_memory', 'both_ways', 'refresh_chart']) expect((await toolOf(request, ctx, name)).ui?.state, name).toBe('changed');
    expect((await toolOf(request, ctx, 'show_memory')).ui?.enabled).toBe(true);

    // "Neue Version anzeigen" via another tool: re-reads, acknowledges, switches unchanged.
    const reads = (await readsOf(request, ctx))[VIEW]!;
    const bothId = (await toolOf(request, ctx, 'both_ways')).id;
    const res = await request.post(`/api/upstreams/${ctx.up.id}/tools/${bothId}/ui/acknowledge`, { headers: ctx.user });
    expect(res.status()).toBe(200);
    expect((await readsOf(request, ctx))[VIEW]).toBe(reads + 1);
    expect((await toolOf(request, ctx, 'show_memory')).ui).toMatchObject({ state: 'shown', enabled: true });
    expect((await toolOf(request, ctx, 'both_ways')).ui).toMatchObject({ state: 'off', enabled: false });
    expect((await readRes(request, ctx.up.slug, ctx.token, VIEW)).result.contents[0].text).toBe('<html>chart v2</html>');

    // Only the CSP widens: a change too.
    await fakeControl(request, ctx.up.tenant, 'resources', { ...PAGE_V1, text: '<html>chart v2</html>', _meta: { ui: { csp: { connectDomains: ['https://api.example', 'https://evil.example'] } } } });
    expectRefused(await readRes(request, null, ctx.token, unified(ctx.up.slug, VIEW)), unified(ctx.up.slug, VIEW));
    expect((await toolOf(request, ctx, 'show_memory')).ui?.state).toBe('changed');
    expect((await toolOf(request, ctx, 'show_memory')).ui?.csp?.connectDomains).toEqual(['https://api.example', 'https://evil.example']);
    await request.post(`/api/upstreams/${ctx.up.id}/tools/${bothId}/ui/acknowledge`, { headers: ctx.user });

    // A background read that sees a change does the same before any host read.
    await fakeControl(request, ctx.up.tenant, 'resources', { ...PAGE_V1, text: '<html>chart v3</html>' });
    await new Promise((r) => setTimeout(r, TOOLS_FRESH_MS + 100));
    const before = (await readsOf(request, ctx))[VIEW]!;
    await refresh(request, ctx);
    await expect.poll(async () => (await toolOf(request, ctx, 'show_memory')).ui?.state, { timeout: 5000 }).toBe('changed');
    expect((await readsOf(request, ctx))[VIEW]).toBe(before + 1);
    expect(JSON.stringify(await listTools(request, ctx.up.slug, ctx.token))).not.toContain('ui://');
  });

  test('TC-249: no credentials, no oversize; resources/list lists exactly the shown pages; the built-in upstream has none', async ({ request }) => {
    const user = freshUser('apps249');
    // A HEADER upstream whose page echoes the credential it was read with.
    const tenant = newTenant('apps249');
    const up = await createUpstream(request, user, {
      url: `${FAKE_UPSTREAM}/t/${tenant}/mcp`,
      auth: 'HEADER',
      headerName: FAKE_HEADER_NAME,
      headerValue: FAKE_HEADER_SECRET,
      defaultPolicy: 'ALLOW',
      name: uniq('Apps 249'),
    });
    await fakeControl(request, tenant, 'tools', { name: 'show_memory', description: 'Chart.', _meta: { ui: { resourceUri: VIEW } } });
    await fakeControl(request, tenant, 'tools', { name: 'solo', description: 'Own page.', _meta: { ui: { resourceUri: SOLO } } });
    await fakeControl(request, tenant, 'resources', { uri: VIEW, text: '<html>secret', echoCredential: true });
    await fakeControl(request, tenant, 'resources', { uri: SOLO, text: '<html>solo</html>' });
    const c = await runOAuthFlow(request, uniq('apps249 client'), user);
    const ctx: Ctx = { user, up: { ...up, tenant }, token: c.accessToken, clientId: 0 };
    await refresh(request, ctx);
    await waitRead(ctx, VIEW);
    // Nothing shown yet: nothing listed.
    expect((await rpc(request, up.slug, ctx.token, 'resources/list')).result.resources).toEqual([]);
    expect((await rpc(request, null, ctx.token, 'resources/list')).result.resources).toEqual([]);
    await show(request, ctx);
    const text = (await readRes(request, up.slug, ctx.token, VIEW)).result.contents[0].text as string;
    expect(text).toContain('[xitl: entfernt]');
    expect(text).not.toContain(FAKE_HEADER_SECRET);
    expect(pageRow(ctx, VIEW)!.csp).toBeNull();
    // resources/list: exactly the shown pages (solo is not shown).
    expect((await rpc(request, up.slug, ctx.token, 'resources/list')).result.resources).toEqual([{ uri: VIEW, name: 'show_memory', mimeType: MIME }]);
    expect((await rpc(request, null, ctx.token, 'resources/list')).result.resources).toEqual([
      { uri: unified(up.slug, VIEW), name: `${up.slug}_show_memory`, mimeType: MIME },
    ]);
    for (const slug of [up.slug, null]) expect((await rpc(request, slug, ctx.token, 'resources/templates/list')).result.resourceTemplates).toEqual([]);
    // Oversize and a second item with another uri: refused (and recorded as changed, never served).
    for (const page of [{ text: 'x', padTo: 2 * 1024 * 1024 + 10 }, { text: '<html>secret', echoCredential: true, extraItem: true }]) {
      await fakeControl(request, tenant, 'resources', { uri: VIEW, ...page });
      expectRefused(await readRes(request, up.slug, ctx.token, VIEW), VIEW);
    }
    // Built-in xitl upstream: no view references, nothing listed.
    const xi = await request.post('/api/upstreams/builtin', { headers: user });
    expect(xi.status()).toBe(201);
    const xiUp = (await xi.json()) as { id: number; slug: string };
    expect((await request.post(`/api/upstreams/${xiUp.id}/tools/refresh`, { headers: user })).status()).toBe(200);
    expect(dbAll('select count(*) n from KnownTool where upstreamId = ? and (uiResourceUri is not null or uiMeta != ?)', xiUp.id, 'null')[0].n).toBe(0);
    expect((await rpc(request, xiUp.slug, ctx.token, 'resources/list')).result.resources).toEqual([]);
  });

  test('TC-250: calls of a shown view\'s tool and of a view-only tool go through policy like any call', async ({ request }) => {
    const ctx = await setup(request, 'apps250', { defaultPolicy: 'ASK' });
    await refresh(request, ctx);
    await waitRead(ctx, VIEW);
    await show(request, ctx);
    // ASK -> held; denied by the human -> denied, audited.
    for (const name of ['show_memory', 'refresh_chart']) {
      const pending = callTool(request, null, ctx.token, `${ctx.up.slug}_${name}`);
      const held = await waitPending(request, ctx.up.id, name, ctx.user);
      expect((await decide(request, held.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
      const r = await pending;
      expect(r.isError).toBe(true);
      expect(dbAll('select outcome, decisionPath from AuditEntry where approvalId = ?', held.id)[0]).toEqual({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+denied:page' });
    }
    // A DENY rule on the view-only tool: denied at once, never forwarded.
    const rid = (await toolOf(request, ctx, 'refresh_chart')).id;
    expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${rid}`, { headers: ctx.user, data: { policy: 'DENY' } })).status()).toBe(200);
    const denied = await callTool(request, ctx.up.slug, ctx.token, 'refresh_chart');
    expect(denied.isError).toBe(true);
    expect(dbAll("select outcome, decisionPath from AuditEntry where upstreamId = ? and toolName = 'refresh_chart' order by id desc limit 1", ctx.up.id)[0]).toEqual({
      outcome: 'DENIED',
      decisionPath: 'policy:tool',
    });
    expect((await fakeState(request, ctx.up.tenant)).calls.refresh_chart ?? 0).toBe(0);
  });
});

test.describe('MCP Apps in Regeln (TC-251)', () => {
  test('TC-251 @390x844: Oberfläche row with switch, states, CSP, shared pages, view-only note, help line', async ({ page, request }) => {
    const user = freshUser('apps251');
    const ctx = await setup(request, 'apps251', { user, pages: [PAGE_V1, { uri: SOLO, text: '<html>solo</html>', fail: true }] });
    await refresh(request, ctx);
    await waitRead(ctx, VIEW);
    await waitRead(ctx, SOLO);
    await page.setExtraHTTPHeaders(user);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/regeln/${ctx.up.id}`);

    const card = (name: string) => page.locator(`li.tool[data-tool="${name}"]`);
    const ui = (name: string) => card(name).getByTestId('tool-ui');
    await expect(page.getByTestId('ui-help')).toContainText('Alle Upstreams');
    await expect(page.getByTestId('ui-help')).toContainText('jeder Aufruf läuft durch deine Regeln');
    await expect(ui('show_memory').getByTestId('ui-state')).toHaveText('Neu');
    await expect(ui('show_memory').getByTestId('ui-csp')).toHaveText('Darf verbinden mit: https://api.example');
    await expect(ui('show_memory').getByTestId('ui-shared')).toHaveText('Gleiche Oberfläche wie: both_ways, refresh_chart');
    await expect(ui('refresh_chart')).toContainText('Nur für die Oberfläche');
    await expect(ui('solo').getByTestId('ui-state')).toHaveText('Nicht ladbar');
    await expect(card('list_items').getByTestId('tool-ui')).toHaveCount(0);

    // The switch: reachable above the tab bar, turns the view on.
    const sw = page.getByRole('switch', { name: 'Oberfläche anzeigen: show_memory' });
    await sw.scrollIntoViewIfNeeded();
    await sw.click();
    await expect(ui('show_memory').getByTestId('ui-state')).toHaveText('Wird angezeigt');
    await expect(sw).toBeChecked();
    await expect(ui('both_ways').getByTestId('ui-state')).toHaveText('Aus');

    // Changed page: "Geändert" with "Neue Version anzeigen" on every tool using it.
    await fakeControl(request, ctx.up.tenant, 'resources', { uri: VIEW, text: '<html>v2</html>' });
    expectRefused(await readRes(request, ctx.up.slug, ctx.token, VIEW), VIEW);
    await page.reload();
    for (const name of ['show_memory', 'both_ways', 'refresh_chart']) await expect(ui(name).getByTestId('ui-state')).toHaveText('Geändert');
    // A page without csp: no external connections.
    await expect(ui('show_memory').getByTestId('ui-csp')).toHaveText('Keine externen Verbindungen');
    await ui('show_memory').getByRole('button', { name: 'Neue Version anzeigen' }).click();
    await expect(ui('show_memory').getByTestId('ui-state')).toHaveText('Wird angezeigt');
    await expect(ui('both_ways').getByTestId('ui-state')).toHaveText('Aus');

    // No horizontal scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
