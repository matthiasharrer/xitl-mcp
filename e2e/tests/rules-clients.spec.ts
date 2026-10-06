// TC-127: "Pro Client" in Regeln lists every client that can reach the
// upstream: OAuth clients, the upstream's own tokens and all-upstreams tokens
// (ADR-0018); paused ones with a "pausiert" chip. A per-client rule for an
// all-upstreams token applies on /mcp. A one-upstream token of A is neither
// listed nor addressable at B.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { dbAll, uniq } from '../support/db.js';
import { callTool, connectedUpstream, fakeState } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

type User = Record<string, string>;
let n = 0;
const freshUser = (): User => ({ 'Remote-User': `rc-${Date.now().toString(36)}${(++n).toString(36)}`, 'Remote-Name': 'Rita' });

async function upstreamOf(request: APIRequestContext, prefix: string, user: User) {
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`RC ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  return up;
}
async function token(request: APIRequestContext, user: User, name: string, upstreamId?: number) {
  const res = await request.post(upstreamId ? `/api/upstreams/${upstreamId}/tokens` : '/api/mcp/tokens', { headers: user, data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { client: { id: number; name: string }; token: string };
}
const toolsView = async (request: APIRequestContext, user: User, upstreamId: number) =>
  (await (await request.get(`/api/upstreams/${upstreamId}/tools`, { headers: user })).json()) as {
    clients: { id: number; name: string; paused: boolean }[];
    tools: { id: number; name: string }[];
  };

test('TC-127 Token für alle Upstreams in "Pro Client" jedes Upstreams; Regel gilt auf /mcp; pausiert sichtbar; Token eines Upstreams nicht beim anderen', async ({ page, request }) => {
  const user = freshUser();
  const A = await upstreamOf(request, 'rca', user);
  const B = await upstreamOf(request, 'rcb', user);
  const all = await token(request, user, uniq('Alle'));
  const onlyA = await token(request, user, uniq('Nur A'), A.id);

  const viewA = await toolsView(request, user, A.id);
  const viewB = await toolsView(request, user, B.id);
  expect(viewA.clients.map((c) => c.id)).toEqual(expect.arrayContaining([all.client.id, onlyA.client.id]));
  expect(viewB.clients.map((c) => c.id)).toContain(all.client.id);
  expect(viewB.clients.map((c) => c.id)).not.toContain(onlyA.client.id);

  // The one-upstream token of A is not addressable at B.
  const toolB = viewB.tools.find((t) => t.name === 'list_items')!;
  expect((await request.put(`/api/upstreams/${B.id}/tools/${toolB.id}/clients/${onlyA.client.id}`, { headers: user, data: { policy: 'ALLOW' } })).status()).toBe(404);

  // A per-client rule for the all-upstreams token applies on /mcp.
  const putB = (tool: string, policy: string) => {
    const t = viewB.tools.find((x) => x.name === tool)!;
    return request.put(`/api/upstreams/${B.id}/tools/${t.id}/clients/${all.client.id}`, { headers: user, data: { policy } });
  };
  expect((await putB('list_items', 'ALLOW')).status()).toBe(200);
  expect((await putB('add_item', 'DENY')).status()).toBe(200);
  const allowed = await callTool(request, null, all.token, `${B.slug}_list_items`, {});
  expect(allowed.isError).toBeFalsy();
  const denied = await callTool(request, null, all.token, `${B.slug}_add_item`, { item: 'x' });
  expect(denied.isError).toBe(true);
  const audit = dbAll('select toolName, outcome, decisionPath from AuditEntry where upstreamId = ? order by id', B.id);
  expect(audit).toEqual([
    { toolName: 'list_items', outcome: 'FORWARDED', decisionPath: 'policy:client' },
    { toolName: 'add_item', outcome: 'DENIED', decisionPath: 'policy:client' },
  ]);
  expect((await fakeState(request, B.tenant)).calls.add_item ?? 0).toBe(0);

  // Paused: still listed, flagged.
  expect((await request.patch(`/api/mcp/clients/${all.client.id}`, { headers: user, data: { paused: true } })).status()).toBe(200);
  expect((await toolsView(request, user, B.id)).clients.find((c) => c.id === all.client.id)).toMatchObject({ paused: true });

  // UI at 390×844: the chip next to the name.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().setExtraHTTPHeaders(user);
  await page.goto(`/#/regeln/${B.id}`);
  const tool = page.locator('li.tool[data-tool="list_items"]');
  await tool.locator('summary').click();
  const row = tool.locator('label.client-row', { hasText: all.client.name });
  await expect(row.getByTestId('client-paused')).toHaveText('pausiert');
  await expect(tool.locator('label.client-row', { hasText: onlyA.client.name })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
