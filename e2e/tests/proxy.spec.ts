// Proxy and policy (ADR-0004, ADR-0014): TC-19…TC-23, TC-25, TC-26 against the
// fake upstream. TC-24 is the unit suite (apps/api/src/lib/policy.test.ts).
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ANNA, MATTHIAS, createUpstream, dbAll, uniq } from '../support/db.js';
import { INITIALIZE, runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeMcpUrl, fakeState, listTools, mcp, newTenant } from '../support/upstream.js';
import { decide, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

const STAMP = '[xitl] Erfordert Freigabe durch';

async function toolsView(request: APIRequestContext, upstreamId: number, user = MATTHIAS) {
  const res = await request.get(`/api/upstreams/${upstreamId}/tools`, { headers: user });
  expect(res.status()).toBe(200);
  return res.json() as Promise<{ tools: { id: number; name: string; isNew: boolean; hint: string; policy: string | null; effectivePolicy: string; path: string }[]; clients: { id: number; name: string }[] }>;
}

async function setToolPolicy(request: APIRequestContext, upstreamId: number, name: string, policy: string | null) {
  const tool = (await toolsView(request, upstreamId)).tools.find((t) => t.name === name)!;
  const res = await request.patch(`/api/upstreams/${upstreamId}/tools/${tool.id}`, { headers: MATTHIAS, data: { policy } });
  expect(res.status()).toBe(200);
  return tool.id;
}

const lastAudit = (upstreamId: number) =>
  dbAll('select * from AuditEntry where upstreamId = ? order by id desc limit 1', upstreamId)[0];

/** Default ASK; list_items ALLOW, delete_all DENY, add_item follows the default (ASK). */
async function policyUpstream(request: APIRequestContext, prefix: string) {
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', description: 'Einkaufsliste (Fake)' });
  const refreshed = await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: MATTHIAS });
  expect(refreshed.status()).toBe(200);
  await setToolPolicy(request, up.id, 'list_items', 'ALLOW');
  await setToolPolicy(request, up.id, 'delete_all', 'DENY');
  const m = await runOAuthFlow(request, uniq(prefix), MATTHIAS);
  return { up, token: m.accessToken, clientId: m.clientId };
}

test('TC-19 initialize mit Upstream-Instructions; tools/list: ask mit Stempel, deny fehlt, Rest unverändert', async ({ request }) => {
  const { up, token } = await policyUpstream(request, 'tc19');

  const init = await mcp(request, up.slug, token, 'initialize', INITIALIZE.params);
  expect(init.result.serverInfo.name).toBe(`xitl/${up.slug}`);
  expect(init.result.instructions).toContain(`Fake-Upstream ${up.tenant}: Einkaufsliste.`);
  expect(init.result.instructions.startsWith('Über xitl vermittelt')).toBe(true);
  expect(Object.keys(init.result.capabilities)).toEqual(['tools']);
  // remembered for when the upstream is unreachable
  expect(dbAll('select instructions from Upstream where id = ?', up.id)[0].instructions).toContain(`Fake-Upstream ${up.tenant}`);

  const tools = await listTools(request, up.slug, token);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(Object.keys(byName).sort()).toEqual(['add_item', 'list_items']);
  // allow: exactly the upstream's definition
  expect(byName.list_items).toEqual({
    name: 'list_items',
    description: 'Lists the shopping list items.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  });
  // ask: same name/schema/annotations, description stamped
  expect(byName.add_item!.description).toBe(
    'Adds an item to the shopping list.\n\n[xitl] Erfordert Freigabe durch Matthias; die Antwort kann bis zu 5 Minuten dauern. / Requires approval by Matthias; may take up to 5 minutes.',
  );
  expect(byName.add_item!.inputSchema).toEqual({ type: 'object', properties: { item: { type: 'string' } }, required: ['item'] });
  expect(byName.add_item!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
});

test('TC-20 allow-Tool wird weitergeleitet, Ergebnis unverändert, Audit FORWARDED', async ({ request }) => {
  const { up, token } = await policyUpstream(request, 'tc20');
  const result = await callTool(request, up.slug, token, 'list_items', { egal: 1 });
  expect(result).toEqual({ content: [{ type: 'text', text: 'Milch, Brot' }], structuredContent: { items: ['Milch', 'Brot'] } });
  expect((await fakeState(request, up.tenant)).calls.list_items).toBe(1);
  const a = lastAudit(up.id);
  expect(a).toMatchObject({
    toolName: 'list_items',
    outcome: 'FORWARDED',
    policy: 'ALLOW',
    decisionPath: 'policy:tool',
    endpoint: `/mcp/${up.slug}`,
    isError: 0,
    resultText: 'Milch, Brot',
  });
  expect(JSON.parse(a.arguments)).toEqual({ egal: 1 });
  expect(a.receivedAt).toBeTruthy();
  expect(a.finishedAt).toBeTruthy();
  expect(a.mcpClientId).toBeTruthy();
  expect(dbAll('select count(*) n from AuditEntry where upstreamId = ?', up.id)[0].n).toBe(1);
});

test('TC-21 deny-Tool (versteckt, trotzdem per Name gerufen) -> isError, Upstream nicht gerufen, Audit DENIED', async ({ request }) => {
  const { up, token } = await policyUpstream(request, 'tc21');
  const result = await callTool(request, up.slug, token, 'delete_all');
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('Verweigert');
  expect(result.content[0]!.text).toContain('Denied');
  expect((await fakeState(request, up.tenant)).calls.delete_all ?? 0).toBe(0);
  expect(lastAudit(up.id)).toMatchObject({ toolName: 'delete_all', outcome: 'DENIED', policy: 'DENY', decisionPath: 'policy:tool' });

  // a name the upstream never listed: denied as unknown, still audited
  const guess = await callTool(request, up.slug, token, 'drop_database', { really: true });
  expect(guess.isError).toBe(true);
  expect(lastAudit(up.id)).toMatchObject({ toolName: 'drop_database', outcome: 'DENIED', policy: 'DENY', decisionPath: 'unknown-tool' });
  expect(Object.keys((await fakeState(request, up.tenant)).calls)).toEqual([]);
});

// TC-22 was "ASK is denied until approval exists (ask:no-channel)". Slice 6
// replaced that spot: an ASK call is now held for the user (TC-27…29). Kept as
// the regression that ASK never forwards by itself.
test('TC-22 (abgelöst durch TC-27…29) ask-Tool wird gehalten, nicht weitergeleitet; Ablehnen -> DENIED', async ({ request }) => {
  const { up, token } = await policyUpstream(request, 'tc22');
  const held = callTool(request, up.slug, token, 'add_item', { item: 'Eier' });
  const p = await waitPending(request, up.id, 'add_item');
  expect((await fakeState(request, up.tenant)).calls.add_item ?? 0).toBe(0);
  expect(lastAudit(up.id)).toMatchObject({ toolName: 'add_item', outcome: 'PENDING', policy: 'ASK' });
  expect((await decide(request, p.id, { decision: 'deny' })).status()).toBe(200);
  const result = await held;
  expect(result.isError).toBe(true);
  expect((await fakeState(request, up.tenant)).calls.add_item ?? 0).toBe(0);
  const a = lastAudit(up.id);
  expect(a).toMatchObject({ toolName: 'add_item', outcome: 'DENIED', policy: 'ASK', decisionPath: 'policy:upstream-default+denied:page' });
  expect(JSON.parse(a.arguments)).toEqual({ item: 'Eier' });
});

test.describe('im Browser', () => {
  test.use({ extraHTTPHeaders: MATTHIAS });

  test('TC-23 Später hinzugekommenes Tool ist "Fragen" trotz Standard Erlauben, "Neu" in der UI; nach Bestätigung gilt der Standard', async ({ page, request }) => {
    const up = await connectedUpstream(request, 'tc23', { defaultPolicy: 'ALLOW' });
    const m = await runOAuthFlow(request, uniq('tc23'), MATTHIAS);
    // the first list is the baseline: everything follows the default
    const first = await listTools(request, up.slug, m.accessToken);
    expect(first.map((t) => t.name).sort()).toEqual(['add_item', 'delete_all', 'list_items']);
    expect(first.every((t) => !t.description?.includes(STAMP))).toBe(true);

    await fakeControl(request, up.tenant, 'tools', { name: 'sneaky_tool', description: 'Added later.' });
    const second = await listTools(request, up.slug, m.accessToken);
    const sneaky = second.find((t) => t.name === 'sneaky_tool')!;
    expect(sneaky.description).toContain(STAMP);
    const held = callTool(request, up.slug, m.accessToken, 'sneaky_tool');
    const p = await waitPending(request, up.id, 'sneaky_tool');
    expect((await decide(request, p.id, { decision: 'deny' })).status()).toBe(200);
    expect((await held).isError).toBe(true);
    expect(lastAudit(up.id).decisionPath).toBe('new-tool+denied:page');
    expect((await fakeState(request, up.tenant)).calls.sneaky_tool ?? 0).toBe(0);

    // the policy UI marks it "Neu"
    await page.goto(`/#/regeln/${up.id}`);
    const item = page.locator('li.tool', { hasText: 'sneaky_tool' });
    await expect(item.locator('.badge', { hasText: 'Neu' })).toBeVisible();
    await expect(page.locator('li.tool', { hasText: 'list_items' }).locator('.badge', { hasText: 'Neu' })).toHaveCount(0);
    await item.getByRole('button', { name: 'Gesehen, Standard anwenden' }).click();
    await expect(item.locator('.badge', { hasText: 'Neu' })).toHaveCount(0);

    // now the default (ALLOW) applies
    const third = await listTools(request, up.slug, m.accessToken);
    expect(third.find((t) => t.name === 'sneaky_tool')!.description).toBe('Added later.');
    const ok = await callTool(request, up.slug, m.accessToken, 'sneaky_tool');
    expect(ok).toEqual({ content: [{ type: 'text', text: 'ok:sneaky_tool' }] });
    expect(lastAudit(up.id)).toMatchObject({ outcome: 'FORWARDED', decisionPath: 'policy:upstream-default' });

    // setting a policy also counts as acknowledging
    await fakeControl(request, up.tenant, 'tools', { name: 'later_two' });
    await listTools(request, up.slug, m.accessToken);
    expect((await toolsView(request, up.id)).tools.find((t) => t.name === 'later_two')!.isNew).toBe(true);
    await setToolPolicy(request, up.id, 'later_two', null);
    expect((await toolsView(request, up.id)).tools.find((t) => t.name === 'later_two')).toMatchObject({ isNew: false, effectivePolicy: 'ALLOW' });
  });

  test('TC-25 Regeln-Ansicht (390x844): Hinweise, Standard/Erlauben/Fragen/Verbieten, pro Client; wirkt beim nächsten tools/list', async ({ page, request }) => {
    const name = uniq('Regeln TC25');
    const up = await connectedUpstream(request, 'tc25', { name, defaultPolicy: 'ALLOW' });
    const a = await runOAuthFlow(request, uniq('Client A TC25'), MATTHIAS);
    const b = await runOAuthFlow(request, uniq('Client B TC25'), MATTHIAS);
    const clientA = dbAll('select name from McpClient where clientId = ?', a.clientId)[0].name as string;

    await page.goto('/#/einstellungen');
    await page.locator('li.item', { hasText: name }).getByRole('link', { name: /Regeln/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/regeln/${up.id}$`));
    await expect(page.getByRole('heading', { name: `Regeln für „${name}“` })).toBeVisible();
    await expect(page.getByText('Noch keine Tools bekannt.')).toBeVisible();
    await page.getByRole('button', { name: 'Tools aktualisieren' }).click();

    const tool = (n: string) => page.locator('li.tool', { hasText: n });
    await expect(tool('list_items').locator('.chip')).toHaveText('Lesen');
    await expect(tool('add_item').locator('.chip')).toHaveText('Schreiben');
    await expect(tool('delete_all').locator('.chip')).toHaveText('Destruktiv');
    const group = tool('add_item').getByRole('radiogroup', { name: 'Regel für add_item' });
    for (const label of ['Standard', 'Erlauben', 'Fragen', 'Verbieten']) await expect(group.getByText(label, { exact: true })).toBeVisible();

    // tap targets and no horizontal scroll
    const box = await group.getByText('Verbieten', { exact: true }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    // Verbieten -> gone from the next tools/list
    await group.getByText('Verbieten', { exact: true }).click();
    await expect(tool('add_item').getByText('Gilt: Verbieten')).toBeVisible();
    expect((await listTools(request, up.slug, a.accessToken)).map((t) => t.name)).not.toContain('add_item');

    // Standard default -> Fragen: list_items gets the stamp
    await page.getByRole('radiogroup', { name: 'Standard-Regel' }).getByText('Fragen', { exact: true }).click();
    await expect(tool('list_items').getByText('Gilt: Fragen')).toBeVisible();
    expect((await listTools(request, up.slug, a.accessToken)).find((t) => t.name === 'list_items')!.description).toContain(STAMP);

    // per client: delete_all "Erlauben" for client A only
    const del = tool('delete_all');
    await del.locator('summary').click();
    await del.getByRole('combobox', { name: `Regel für delete_all bei ${clientA}` }).selectOption('ALLOW');
    await expect(del.locator('summary')).toContainText('1 abweichend');
    const forA = (await listTools(request, up.slug, a.accessToken)).find((t) => t.name === 'delete_all');
    const forB = (await listTools(request, up.slug, b.accessToken)).find((t) => t.name === 'delete_all');
    expect(forA!.description).toBe('Deletes every item.');
    expect(forB!.description).toContain(STAMP);
    expect((await callTool(request, up.slug, a.accessToken, 'delete_all')).isError).toBeFalsy();
    expect(lastAudit(up.id).decisionPath).toBe('policy:client');
    expect((await callTool(request, up.slug, b.accessToken, 'delete_all')).isError).toBe(true);

    // back to "Wie oben"
    await del.getByRole('combobox', { name: `Regel für delete_all bei ${clientA}` }).selectOption('');
    await expect(del.locator('summary')).not.toContainText('abweichend');
    expect((await listTools(request, up.slug, a.accessToken)).find((t) => t.name === 'delete_all')!.description).toContain(STAMP);
  });
});

test('TC-26 Tools und Regeln sind pro Nutzer: anna bekommt 404, fremde Clients/Tools werden abgelehnt', async ({ request }) => {
  const { up } = await policyUpstream(request, 'tc26');
  const view = await toolsView(request, up.id);
  const toolId = view.tools[0]!.id;
  const mine = view.clients[0]!.id;
  const annaClient = await runOAuthFlow(request, uniq('tc26 anna'), ANNA);
  const annaClientId = dbAll('select id from McpClient where clientId = ?', annaClient.clientId)[0].id;

  const attempts: [string, string, unknown?][] = [
    ['GET', `/api/upstreams/${up.id}/tools`],
    ['POST', `/api/upstreams/${up.id}/tools/refresh`],
    ['PATCH', `/api/upstreams/${up.id}/tools/${toolId}`, { policy: 'ALLOW' }],
    ['POST', `/api/upstreams/${up.id}/tools/${toolId}/acknowledge`],
    ['PUT', `/api/upstreams/${up.id}/tools/${toolId}/clients/${annaClientId}`, { policy: 'ALLOW' }],
    ['DELETE', `/api/upstreams/${up.id}/tools/${toolId}/clients/${annaClientId}`],
    ['POST', `/api/upstreams/${up.id}/connect`],
  ];
  for (const [method, url, data] of attempts) {
    const res = await request.fetch(url, { method, headers: ANNA, data });
    expect(res.status(), `${method} ${url}`).toBe(404);
  }
  // matthias cannot attach anna's client, nor reach a tool through another upstream
  expect((await request.put(`/api/upstreams/${up.id}/tools/${toolId}/clients/${annaClientId}`, { headers: MATTHIAS, data: { policy: 'ALLOW' } })).status()).toBe(404);
  const other = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(newTenant('tc26o')) });
  expect((await request.patch(`/api/upstreams/${other.id}/tools/${toolId}`, { headers: MATTHIAS, data: { policy: 'ALLOW' } })).status()).toBe(404);
  // a cross-site browser request (CSRF) is refused before anything happens
  const csrf = await request.post(`/api/upstreams/${up.id}/tools/${toolId}/acknowledge`, {
    headers: { ...MATTHIAS, 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(csrf.status()).toBe(403);
  // bad input
  expect((await request.patch(`/api/upstreams/${up.id}/tools/${toolId}`, { headers: MATTHIAS, data: { policy: 'always_allow' } })).status()).toBe(400);
  expect((await request.put(`/api/upstreams/${up.id}/tools/${toolId}/clients/${mine}`, { headers: MATTHIAS, data: { policy: null } })).status()).toBe(400);

  // nothing changed by anna's attempts
  const after = await toolsView(request, up.id);
  expect(after.tools.find((t) => t.id === toolId)!.policy).toBe(view.tools[0]!.policy);
  expect(dbAll('select count(*) n from ClientToolPolicy where mcpClientId = ?', annaClientId)[0].n).toBe(0);
});
