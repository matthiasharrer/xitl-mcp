// Malicious-client suite, part 2 (docs/testing.md TC-46…48): an upstream (or
// its authorization server) attacking xitl. The fake upstream's malicious
// modes are switched per tenant (`fakeMalice`, see `Malice` in
// e2e/support/fakeUpstream.ts); redirects point at a second fake host (the
// sink) that records whatever reaches it.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { MATTHIAS, createUpstream, dbAll, uniq } from '../support/db.js';
import { INITIALIZE, LIST, parseRpc, postMcp, runOAuthFlow } from '../support/mcpClient.js';
import { API_LOG, FAKE_HEADER_NAME, FAKE_HEADER_SECRET, FAKE_UPSTREAM } from '../support/paths.js';
import {
  callTool,
  connectedUpstream,
  connectViaApi,
  fakeControl,
  fakeMalice,
  fakeMcpUrl,
  fakeState,
  listTools,
  newTenant,
  sinkRequests,
  startConnect,
} from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

const row = (id: number) => dbAll('select * from Upstream where id = ?', id)[0];

/** A fresh OAUTH upstream on a fresh tenant, not connected yet. */
async function oauthUpstream(request: import('@playwright/test').APIRequestContext, prefix: string) {
  const tenant = newTenant(prefix);
  const up = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(tenant), defaultPolicy: 'ALLOW' });
  return { ...up, tenant };
}

/** Expects POST connect to be refused with a German message, nothing stored. */
async function expectConnectRefused(request: import('@playwright/test').APIRequestContext, id: number, forbidden: string[] = []) {
  const res = await request.post(`/api/upstreams/${id}/connect`, { headers: MATTHIAS });
  const text = await res.text();
  expect(res.status(), text).toBe(502);
  const body = JSON.parse(text);
  expect(body.authorizationUrl).toBeUndefined();
  expect(body.error).toMatch(/Upstream|Anmelde|Verbindung|Ressource/);
  for (const f of forbidden) expect(text).not.toContain(f);
  const r = row(id);
  expect(r).toMatchObject({ status: 'NOT_CONNECTED', pendingAuth: null, accessToken: null, refreshToken: null, oauthClient: null, oauthMetadata: null });
}

test('TC-46 Bösartiger AS beim Verbinden: falscher issuer, javascript:-Anmeldeadresse, fremde Ressource -> abgelehnt, nichts gespeichert', async ({ request }) => {
  // issuer that doesn't match the AS URL (RFC 8414 §3.3)
  const a = await oauthUpstream(request, 'tc46iss');
  await fakeMalice(request, a.tenant, { issuer: 'https://evil.example/t/x' });
  await expectConnectRefused(request, a.id);

  // authorization_endpoint that isn't http(s)
  for (const bad of ['javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd']) {
    const b = await oauthUpstream(request, 'tc46js');
    await fakeMalice(request, b.tenant, { authorizationEndpoint: bad });
    await expectConnectRefused(request, b.id, [bad.split(':')[0] + ':']);
  }

  // protected-resource document naming another resource: other origin, or another path on the same host
  for (const resource of ['https://evil.example/mcp', `${FAKE_UPSTREAM}/t/someone-else/mcp`, `${FAKE_UPSTREAM}/t/x/mcp/deeper`]) {
    const c = await oauthUpstream(request, 'tc46res');
    await fakeMalice(request, c.tenant, { resource });
    await expectConnectRefused(request, c.id);
    // the resource check comes before DCR: nothing was registered there either
    expect((await fakeState(request, c.tenant)) as any).toMatchObject({ clients: [] });
  }

  // control: the same flow without malice connects (the checks don't refuse everything)
  const ok = await oauthUpstream(request, 'tc46ok');
  await connectViaApi(request, ok.id);
  expect(row(ok.id).status).toBe('CONNECTED');
});

test('TC-47 Weiterleitungen: MCP-Endpunkt, Token-Endpunkt und Discovery mit 307 auf einen fremden Host -> abgelehnt, nichts kommt dort an', async ({ request }) => {
  const m = await runOAuthFlow(request, uniq('tc47'), MATTHIAS);

  // MCP endpoint redirects (OAUTH bearer)
  const up = await connectedUpstream(request, 'tc47mcp', { defaultPolicy: 'ALLOW' });
  expect((await listTools(request, up.slug, m.accessToken)).length).toBeGreaterThan(0);
  await fakeMalice(request, up.tenant, { redirectMcp: true });
  const list = await parseRpc(await postMcp(request, up.slug, m.accessToken, LIST));
  expect(list.error).toBeTruthy();
  const call = await callTool(request, up.slug, m.accessToken, 'list_items');
  expect(call.isError).toBe(true);
  expect(dbAll('select outcome from AuditEntry where upstreamId = ? order by id desc limit 1', up.id)[0].outcome).toBe('UPSTREAM_ERROR');
  expect(await sinkRequests(request, up.tenant)).toEqual([]);

  // MCP endpoint redirects (HEADER credential)
  const htenant = newTenant('tc47h');
  const h = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(htenant), auth: 'HEADER', headerName: FAKE_HEADER_NAME, headerValue: FAKE_HEADER_SECRET, defaultPolicy: 'ALLOW' });
  expect((await listTools(request, h.slug, m.accessToken)).length).toBeGreaterThan(0);
  await fakeMalice(request, htenant, { redirectMcp: true });
  expect((await callTool(request, h.slug, m.accessToken, 'list_items')).isError).toBe(true);
  expect(await sinkRequests(request, htenant)).toEqual([]);

  // token endpoint redirects during refresh: the refresh token is never replayed elsewhere
  const r = await connectedUpstream(request, 'tc47tok', { defaultPolicy: 'ALLOW' });
  await listTools(request, r.slug, m.accessToken);
  expect((await callTool(request, r.slug, m.accessToken, 'list_items')).isError).toBeFalsy();
  await fakeMalice(request, r.tenant, { redirectToken: true });
  await fakeControl(request, r.tenant, 'expire-access');
  const afterExpiry = await callTool(request, r.slug, m.accessToken, 'list_items');
  expect(afterExpiry.isError).toBe(true);
  expect(await sinkRequests(request, r.tenant)).toEqual([]);
  expect((await fakeState(request, r.tenant)).calls.list_items).toBe(1);

  // token endpoint redirects during the code exchange
  const x = await oauthUpstream(request, 'tc47code');
  await fakeMalice(request, x.tenant, { redirectToken: true });
  const callback = await startConnect(request, x.id);
  const done = await request.get(callback, { headers: MATTHIAS, maxRedirects: 0 });
  expect(done.headers()['location']).toBe(`/#/einstellungen?verbindung=fehler&upstream=${x.id}`);
  expect(row(x.id)).toMatchObject({ status: 'NOT_CONNECTED', accessToken: null });
  expect(await sinkRequests(request, x.tenant)).toEqual([]);

  // discovery documents redirect: refused too (no server-side request goes where the upstream points)
  const d = await oauthUpstream(request, 'tc47disc');
  await fakeMalice(request, d.tenant, { redirectDiscovery: true });
  await expectConnectRefused(request, d.id);
  expect(await sinkRequests(request, d.tenant)).toEqual([]);
});

test('TC-48 Upstream gibt xitls Token zurück (Ergebnis, Fehler, Tool-Liste, Instructions) -> entfernt; 10 000 Tools / 50 MB -> begrenzt, Server antwortet weiter', async ({ request }) => {
  const m = await runOAuthFlow(request, uniq('tc48'), MATTHIAS);
  const up = await connectedUpstream(request, 'tc48', { defaultPolicy: 'ALLOW' });
  const tokens = async () => (await fakeState(request, up.tenant)).tokens;
  await fakeMalice(request, up.tenant, { echoInList: true, echoInInstructions: true });

  const listed = await listTools(request, up.slug, m.accessToken);
  const init = await parseRpc(await postMcp(request, up.slug, m.accessToken, INITIALIZE));
  expect(JSON.stringify(listed)).toContain('[xitl: entfernt]');
  expect(init.result.instructions).toContain('[xitl: entfernt]');
  const known = dbAll('select description from KnownTool where upstreamId = ?', up.id);
  const stored = dbAll('select instructions from Upstream where id = ?', up.id)[0].instructions;

  await fakeMalice(request, up.tenant, { echoInErrorResult: true });
  const errResult = await callTool(request, up.slug, m.accessToken, 'list_items');
  expect(errResult.isError).toBe(true);
  expect(JSON.stringify(errResult)).toContain('[xitl: entfernt]');
  const auditText = dbAll('select resultText from AuditEntry where upstreamId = ? order by id desc limit 1', up.id)[0].resultText;

  await fakeMalice(request, up.tenant, { echoInErrorResult: false, echoInError: true });
  const rpcError = await callTool(request, up.slug, m.accessToken, 'list_items');
  expect(rpcError.isError).toBe(true);

  const toolsView = await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: MATTHIAS })).text();
  const haystack = [JSON.stringify(listed), JSON.stringify(init), JSON.stringify(known), stored, JSON.stringify(errResult), auditText, JSON.stringify(rpcError), toolsView, fs.readFileSync(API_LOG, 'utf8')].join('\n');
  const issued = await tokens();
  expect(issued.length).toBeGreaterThan(0);
  for (const t of issued) expect(haystack).not.toContain(t);

  // 10 000 tools: bounded to 500, recorded as 500, server still answers
  const many = await connectedUpstream(request, 'tc48many', { defaultPolicy: 'ALLOW' }, MATTHIAS, (t) => fakeMalice(request, t, { toolCount: 10_000 }));
  const t0 = Date.now();
  const manyListed = await listTools(request, many.slug, m.accessToken);
  expect(manyListed).toHaveLength(500);
  expect(dbAll('select count(*) n from KnownTool where upstreamId = ?', many.id)[0].n).toBe(500);
  expect(Date.now() - t0).toBeLessThan(20_000);
  const beyond = await callTool(request, many.slug, m.accessToken, 'bulk_9999');
  expect(beyond.isError).toBe(true);
  expect(dbAll('select decisionPath from AuditEntry where upstreamId = ? order by id desc limit 1', many.id)[0].decisionPath).toBe('unknown-tool');
  expect((await fakeState(request, many.tenant)).calls.bulk_9999 ?? 0).toBe(0);

  // a 50 MB tool list: refused, nothing recorded, the server stays responsive
  const huge = await connectedUpstream(request, 'tc48huge', { defaultPolicy: 'ALLOW' }, MATTHIAS, (t) => fakeMalice(request, t, { padBytes: 50 * 1024 * 1024 }));
  const hugeList = await parseRpc(await postMcp(request, huge.slug, m.accessToken, LIST));
  expect(hugeList.error).toBeTruthy();
  expect(dbAll('select count(*) n from KnownTool where upstreamId = ?', huge.id)[0].n).toBe(0);
  const refresh = await request.post(`/api/upstreams/${huge.id}/tools/refresh`, { headers: MATTHIAS });
  expect(refresh.status()).toBe(502);
  expect((await request.get('/api/health')).status()).toBe(200);
  expect((await listTools(request, up.slug, m.accessToken)).length).toBeGreaterThan(0);
});
