// xitl as its own upstream (lib/selfLoop.ts): TC-130…131.
import { test, expect } from '@playwright/test';
import { MATTHIAS, createUpstream, dbAll, uniqSlug } from '../support/db.js';
import { MCP_HEADERS } from '../support/mcpClient.js';
import { PORT } from '../support/paths.js';
import { connectedUpstream, listTools } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

const OWN_ADDRESS = {
  error: 'Das ist die Adresse von xitl selbst. Trag die Adresse des eigentlichen MCP-Servers ein.',
  code: 'own_address',
};

async function tokenFor(request: import('@playwright/test').APIRequestContext, upstreamId: number) {
  const res = await request.post(`/api/upstreams/${upstreamId}/tokens`, { headers: MATTHIAS, data: { name: 'tc130' } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { client: { id: number }; token: string };
}

test("TC-130 Upstream-URL auf xitl's eigener Adresse -> 400 own_address beim Anlegen und Ändern; nichts gespeichert", async ({ request }) => {
  const own = `http://127.0.0.1:${PORT}`;
  for (const url of [`${own}/mcp/rezepte`, `${own}/mcp`, `${own}/`]) {
    const slug = uniqSlug('tc130');
    const res = await request.post('/api/upstreams', { headers: MATTHIAS, data: { name: 'Ich selbst', slug, url, allowInternal: true } });
    expect(res.status(), url).toBe(400);
    expect(await res.json(), url).toEqual(OWN_ADDRESS);
    expect(dbAll('select id from Upstream where slug = ?', slug), url).toEqual([]);
  }

  const up = await createUpstream(request, MATTHIAS);
  const patch = await request.patch(`/api/upstreams/${up.id}`, { headers: MATTHIAS, data: { url: `${own}/mcp/x`, allowInternal: true } });
  expect(patch.status()).toBe(400);
  expect(await patch.json()).toEqual(OWN_ADDRESS);
  expect(dbAll('select url from Upstream where id = ?', up.id)[0].url).toBe('https://example.com/mcp');
  await request.delete(`/api/upstreams/${up.id}`, { headers: MATTHIAS });
});

test('TC-131 Schleife über einen anderen Namen (localhost statt 127.0.0.1): der innere Endpunkt lehnt ab (508), sein Token bleibt unbenutzt; fremde Kennung wird nicht abgelehnt', async ({
  request,
}) => {
  const inner = await connectedUpstream(request, 'tc131in');
  const innerToken = await tokenFor(request, inner.id);

  // A different name for ourselves: the save-time check can't see it.
  const outer = await createUpstream(request, MATTHIAS, {
    url: `http://localhost:${PORT}/mcp/${inner.slug}`,
    allowInternal: true,
    auth: 'HEADER',
    headerName: 'Authorization',
    headerValue: `Bearer ${innerToken.token}`,
  });
  const outerToken = await tokenFor(request, outer.id);

  const res = await request.post(`/mcp/${outer.slug}`, {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${outerToken.token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  expect(await res.text()).not.toContain('"name":"');
  // Refused before the bearer gate: the inner token was never used.
  expect(dbAll('select lastUsedAt from McpClient where id = ?', innerToken.client.id)[0].lastUsedAt).toBeNull();

  // Control: a foreign instance id (another xitl) is not refused.
  const foreign = await request.post(`/mcp/${inner.slug}`, {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${innerToken.token}`, 'X-Xitl-Instance': '0'.repeat(32) },
    data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  expect(foreign.status()).toBe(200);
  expect((await listTools(request, inner.slug, innerToken.token)).length).toBeGreaterThan(0);

  for (const id of [outer.id, inner.id]) await request.delete(`/api/upstreams/${id}`, { headers: MATTHIAS });
});
