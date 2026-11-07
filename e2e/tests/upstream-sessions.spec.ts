// Session handles as a tool parameter (ADR-0040): TC-266…TC-273. An upstream
// marked „Sitzungen über Parameter“ (the fake's session mode, like Playwright
// MCP) gets `xitl_session` on every tool; a call without it opens a kept
// upstream session under a new handle, a call with it runs there (also
// across approvals); handles are per MCP client; the end tool ends it; a lost
// session is reopened under the same handle. Pool mechanics (idle sweep,
// identity, concurrency, credentials per call) are unit tests in
// apps/api/src/upstream/sessionPool.test.ts.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { MATTHIAS, dbAll, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeState, listTools } from '../support/upstream.js';
import { decide, startCall, waitPending } from '../support/approval.js';

/** A connected upstream in session mode with `remember` / `recall` / `close`,
 * tools known (the first list acknowledges), and `clients` OAuth clients. */
async function statefulUpstream(request: APIRequestContext, prefix: string, defaultPolicy: 'ALLOW' | 'ASK', opts: { clients?: number; sessionParam?: boolean } = {}) {
  const up = await connectedUpstream(request, prefix, { defaultPolicy }, MATTHIAS, async (tenant) => {
    await fakeControl(request, tenant, 'config', { sessions: true });
    await fakeControl(request, tenant, 'tools', { name: 'remember', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } });
    await fakeControl(request, tenant, 'tools', { name: 'recall', annotations: { readOnlyHint: true } });
    await fakeControl(request, tenant, 'tools', { name: 'close' });
  });
  if (opts.sessionParam !== false) {
    expect((await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { sessionParam: true } })).status()).toBe(200);
  }
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: MATTHIAS })).status()).toBe(200);
  const tokens: string[] = [];
  for (let i = 0; i < (opts.clients ?? 1); i++) tokens.push((await runOAuthFlow(request, uniq(`Client ${prefix}`), MATTHIAS)).accessToken);
  return { up, tokens };
}

type Result = { content: { text: string }[]; isError?: boolean };
const first = (r: Result) => r.content[0]!.text;
const notice = (r: Result) => r.content.slice(1).map((c) => c.text).join('\n');
/** The handle from a „[xitl] Sitzung: <h>.“ / „Neue Sitzung: <h>.“ notice. */
const handleOf = (r: Result) => /Sitzung: ([A-Za-z0-9_-]{6})\./.exec(notice(r))?.[1] ?? null;
const callSessions = async (request: APIRequestContext, tenant: string) => (await fakeState(request, tenant)).sessionCalls;

test('TC-266 tools/list: `xitl_session` an jedem Tool, auf beiden Endpunkten; nicht ohne den Schalter', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc266', 'ALLOW');
  for (const [slug, name] of [[up.slug, 'remember'], [null, `${up.slug}_remember`]] as const) {
    const tool = (await listTools(request, slug, tokens[0]!)).find((t) => t.name === name) as { inputSchema: { properties: Record<string, { type: string }>; required?: string[] } };
    expect(tool.inputSchema.properties.xitl_session?.type).toBe('string');
    expect(tool.inputSchema.properties.value?.type).toBe('string');
    expect(tool.inputSchema.required).toEqual(['value']);
  }
  // ADR-0031: the stored definition is the upstream's own (no "changed" flag)
  const tools = (await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: MATTHIAS })).json()).tools as { name: string; isChanged: boolean; endsSession: boolean }[];
  expect(tools.find((t) => t.name === 'remember')).toMatchObject({ isChanged: false, endsSession: false });

  const plain = await statefulUpstream(request, 'tc266b', 'ALLOW', { sessionParam: false });
  const t2 = (await listTools(request, plain.up.slug, plain.tokens[0]!)).find((t) => t.name === 'remember') as { inputSchema: { properties: Record<string, unknown> } };
  expect(t2.inputSchema.properties.xitl_session).toBeUndefined();
});

test('TC-267 ⚡ ohne Handle → neue Sitzung + Handle im Ergebnis; mit Handle bleibt der Zustand; Parameter nie weitergeleitet', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc267', 'ALLOW');
  const r1 = await callTool(request, up.slug, tokens[0]!, 'remember', { value: 'example.com' });
  expect(first(r1)).toBe('value=example.com');
  const h = handleOf(r1);
  expect(h).not.toBeNull();
  expect(notice(r1)).toContain('als `xitl_session` mitgeben');
  const r2 = await callTool(request, up.slug, tokens[0]!, 'recall', { xitl_session: h });
  expect(first(r2)).toBe('value=example.com');
  expect(r2.content).toHaveLength(1); // a kept session: no notice
  // the same via /mcp
  const r3 = await callTool(request, null, tokens[0]!, `${up.slug}_recall`, { xitl_session: h });
  expect(first(r3)).toBe('value=example.com');
  const calls = await callSessions(request, up.tenant);
  expect(new Set(calls.map((c) => c.session)).size).toBe(1);
  expect(calls.flatMap((c) => c.argNames)).not.toContain('xitl_session');
  expect((await fakeState(request, up.tenant)).initializes).toBeGreaterThanOrEqual(1);
  // audit: arguments without the parameter, the handle in its own column
  const rows = dbAll('select toolName, arguments, upstreamSession from AuditEntry where upstreamId = ? order by id', up.id) as { toolName: string; arguments: string; upstreamSession: string | null }[];
  expect(rows.map((r) => r.upstreamSession)).toEqual([h, h, h]);
  expect(rows.every((r) => !r.arguments.includes('xitl_session'))).toBe(true);
});

test('TC-268 ⚡ Zustand bleibt über freigabepflichtige Aufrufe; die Karte zeigt die Sitzung, nicht den Parameter', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc268', 'ASK');
  const held1 = startCall(request, up.slug, tokens[0]!, 'remember', { value: 'cookie=1' });
  const p1 = (await waitPending(request, up.id, 'remember')) as unknown as { id: string; arguments: unknown; upstreamSession: unknown };
  expect(p1.upstreamSession).toBeNull(); // „Neue Sitzung“
  expect(p1.arguments).toEqual({ value: 'cookie=1' });
  await decide(request, p1.id, { decision: 'approve' });
  const r1 = (await held1) as Result;
  const h = handleOf(r1);
  expect(h).not.toBeNull();

  const held2 = startCall(request, up.slug, tokens[0]!, 'recall', { xitl_session: h });
  const p2 = (await waitPending(request, up.id, 'recall')) as unknown as { id: string; arguments: unknown; upstreamSession: unknown };
  expect(p2.upstreamSession).toBe(h);
  expect(p2.arguments).toEqual({});
  await decide(request, p2.id, { decision: 'approve' });
  expect(first((await held2) as Result)).toBe('value=cookie=1');
  expect(new Set((await callSessions(request, up.tenant)).map((c) => c.session)).size).toBe(1);
});

test('TC-269 ⚡ ein abgelehnter Aufruf öffnet keine Sitzung', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc269', 'ASK');
  const before = (await fakeState(request, up.tenant)).initializes;
  const held = startCall(request, up.slug, tokens[0]!, 'remember', { value: 'x' });
  await decide(request, (await waitPending(request, up.id, 'remember')).id, { decision: 'deny' });
  const r = (await held) as Result;
  expect(r.isError).toBe(true);
  expect(handleOf(r)).toBeNull();
  expect((await fakeState(request, up.tenant)).initializes).toBe(before);
});

test('TC-270 ⚡ Handles sind je Client: fremder oder unbekannter Handle → neue Sitzung, gleicher Hinweis; Zustand des anderen unberührt', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc270', 'ALLOW', { clients: 2 });
  const hA = handleOf(await callTool(request, up.slug, tokens[0]!, 'remember', { value: 'a' }))!;
  const foreign = await callTool(request, up.slug, tokens[1]!, 'recall', { xitl_session: hA });
  expect(first(foreign)).toBe('value=');
  const hB = handleOf(foreign);
  expect(hB).not.toBeNull();
  expect(hB).not.toBe(hA);
  const unknown = await callTool(request, up.slug, tokens[1]!, 'recall', { xitl_session: 'AAAAAA' });
  const garbage = await callTool(request, up.slug, tokens[1]!, 'recall', { xitl_session: 'nope' });
  // A 22-character handle from before the amendment (2026-11-07) is just malformed now.
  const old = await callTool(request, up.slug, tokens[1]!, 'recall', { xitl_session: 'A8KlUVPGmJgsKwRlKxxanw' });
  // one text for foreign, unknown and malformed (only the new handle differs)
  const shape = (r: Result) => notice(r).replace(/(Sitzung|session): [A-Za-z0-9_-]{6}\./gi, '$1: <h>.');
  expect(shape(foreign)).toContain('unbekannt oder beendet');
  expect(shape(unknown)).toBe(shape(foreign));
  expect(shape(garbage)).toBe(shape(foreign));
  expect(shape(old)).toBe(shape(foreign));
  expect(first(await callTool(request, up.slug, tokens[0]!, 'recall', { xitl_session: hA }))).toBe('value=a');
});

test('TC-271 ⚡ Ende-Tool: nach Erfolg DELETE beim Upstream, Hinweis, Handle danach unbekannt', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc271', 'ALLOW');
  const tools = (await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: MATTHIAS })).json()).tools as { id: number; name: string }[];
  const closeId = tools.find((t) => t.name === 'close')!.id;
  expect((await request.patch(`/api/upstreams/${up.id}/tools/${closeId}`, { headers: MATTHIAS, data: { endsSession: true } })).status()).toBe(200);

  const h = handleOf(await callTool(request, up.slug, tokens[0]!, 'remember', { value: 'v' }))!;
  const [kept] = (await callSessions(request, up.tenant)).map((c) => c.session);
  const closed = await callTool(request, up.slug, tokens[0]!, 'close', { xitl_session: h });
  expect(first(closed)).toBe('closed');
  expect(notice(closed)).toContain('beendet');
  expect((await fakeState(request, up.tenant)).deleted).toContain(kept);
  const after = await callTool(request, up.slug, tokens[0]!, 'recall', { xitl_session: h });
  expect(first(after)).toBe('value=');
  expect(notice(after)).toContain('unbekannt oder beendet');
});

test('TC-272 Upstream hat die Sitzung verloren → unter demselben Handle neu aufgebaut, Aufruf wiederholt, Hinweis', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc272', 'ALLOW');
  const h = handleOf(await callTool(request, up.slug, tokens[0]!, 'remember', { value: 'old' }))!;
  await fakeControl(request, up.tenant, 'config', { forgetSessions: true });
  const r = await callTool(request, up.slug, tokens[0]!, 'recall', { xitl_session: h });
  expect(r.isError).not.toBe(true);
  expect(first(r)).toBe('value=');
  expect(notice(r)).toContain('unter derselben ID neu aufgebaut');
  const row = dbAll("select outcome, upstreamSession from AuditEntry where toolName = 'recall' and upstreamId = ? order by id desc limit 1", up.id)[0] as { outcome: string; upstreamSession: string };
  expect(row).toEqual({ outcome: 'FORWARDED', upstreamSession: h });
  const next = await callTool(request, up.slug, tokens[0]!, 'recall', { xitl_session: h });
  expect(next.content).toHaveLength(1);
});

test('TC-273 ohne den Schalter: unverändert (kein Handle, kein Hinweis, jede Anfrage eine eigene Sitzung)', async ({ request }) => {
  const { up, tokens } = await statefulUpstream(request, 'tc273', 'ALLOW', { sessionParam: false });
  const r1 = await callTool(request, up.slug, tokens[0]!, 'remember', { value: 'v' });
  expect(r1.content).toHaveLength(1);
  expect(first(await callTool(request, up.slug, tokens[0]!, 'recall'))).toBe('value=');
  expect(new Set((await callSessions(request, up.tenant)).map((c) => c.session)).size).toBe(2);
  expect((await fakeState(request, up.tenant)).deleted).toHaveLength(0);
});
