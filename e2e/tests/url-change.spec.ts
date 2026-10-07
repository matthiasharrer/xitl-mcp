// A URL change of an upstream resets trust (ADR-0021): TC-85, TC-86, TC-87.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { MATTHIAS, createUpstream, dbAll, dbRun, uniq } from '../support/db.js';
import { FAKE_HEADER_NAME, FAKE_HEADER_SECRET } from '../support/paths.js';
import { fakeControl, fakeMcpUrl, fakeState, newTenant, callTool } from '../support/upstream.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { decide, lastAudit, startCall, waitPending } from '../support/approval.js';

const HEADER = { auth: 'HEADER', headerName: FAKE_HEADER_NAME, headerValue: FAKE_HEADER_SECRET };
const MESSAGE = 'Neue Adresse: Bitte gib den Header-Wert neu ein.';
const iso = (d: Date) => d.toISOString().replace('Z', '+00:00');

const upstreamRow = (id: number) => dbAll('select url, auth, headerName, headerValue, status from Upstream where id = ?', id)[0];
const toolRows = (id: number) =>
  dbAll('select id, name, policy, acknowledgedAt, changedAt from KnownTool where upstreamId = ? order by name', id) as {
    id: number;
    name: string;
    policy: string | null;
    acknowledgedAt: string | null;
    changedAt: string | null;
  }[];
const snoozeCount = (id: number) => dbAll('select count(*) n from Snooze where upstreamId = ?', id)[0].n as number;

const patch = (request: APIRequestContext, id: number, data: Record<string, unknown>) =>
  request.patch(`/api/upstreams/${id}`, { headers: MATTHIAS, data });

async function refresh(request: APIRequestContext, id: number) {
  const res = await request.post(`/api/upstreams/${id}/tools/refresh`, { headers: MATTHIAS });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A HEADER upstream on a fresh fake tenant, its tools listed once (first
 * list = acknowledged). */
async function headerUpstream(request: APIRequestContext, prefix: string, overrides: Record<string, unknown> = {}) {
  const tenant = newTenant(prefix);
  const up = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(tenant), ...HEADER, ...overrides });
  await refresh(request, up.id);
  return { ...up, tenant };
}

test.describe('TC-85 URL change of a HEADER upstream needs the header value again', () => {
  test('without headerValue -> 400, nothing changes; with one -> 200 and the new value is used', async ({ request }) => {
    const up = await headerUpstream(request, 'tc85');
    const before = upstreamRow(up.id);
    const toolsBefore = toolRows(up.id);
    expect(toolsBefore.length).toBeGreaterThan(0);
    expect(toolsBefore.every((t) => t.acknowledgedAt !== null && t.changedAt === null)).toBe(true);

    // The new tenant only accepts a NEW secret: the old one would get a 401.
    const next = newTenant('tc85n');
    const newSecret = `new-secret-${next}`;
    await fakeControl(request, next, 'config', { headerSecret: newSecret });

    for (const extra of [{}, { headerValue: null }]) {
      const res = await patch(request, up.id, { url: fakeMcpUrl(next), ...extra });
      expect(res.status()).toBe(400);
      expect(await res.json()).toEqual({ error: MESSAGE, code: 'header_value_required' });
      expect(upstreamRow(up.id)).toEqual(before);
      expect(toolRows(up.id)).toEqual(toolsBefore);
    }
    // An empty value is no value either (schema: 400, nothing changes).
    expect((await patch(request, up.id, { url: fakeMcpUrl(next), headerValue: '' })).status()).toBe(400);
    expect(upstreamRow(up.id)).toEqual(before);

    const ok = await patch(request, up.id, { url: fakeMcpUrl(next), headerValue: newSecret });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(JSON.stringify(await ok.json())).not.toContain(newSecret);
    expect(upstreamRow(up.id)).toMatchObject({ url: fakeMcpUrl(next), headerValue: newSecret, auth: 'HEADER' });
    await refresh(request, up.id);
    const seen = await fakeState(request, next);
    expect(seen.authSeen).toContain('header');
    expect(seen.authSeen).not.toContain('none');

    // Only the name: no value needed, the stored one is kept.
    const renamed = await patch(request, up.id, { name: uniq('Umbenannt') });
    expect(renamed.status(), await renamed.text()).toBe(200);
    expect(upstreamRow(up.id).headerValue).toBe(newSecret);
    await refresh(request, up.id);
    expect((await fakeState(request, next)).authSeen).not.toContain('none');
  });

  test('NONE -> HEADER together with a URL change also requires the value', async ({ request }) => {
    const tenant = newTenant('tc85x');
    const up = await createUpstream(request, MATTHIAS, { url: fakeMcpUrl(tenant), auth: 'NONE' });
    const before = upstreamRow(up.id);
    const res = await patch(request, up.id, { url: fakeMcpUrl(newTenant('tc85y')), auth: 'HEADER', headerName: FAKE_HEADER_NAME });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('header_value_required');
    expect(upstreamRow(up.id)).toEqual(before);
  });
});

test('TC-86 URL change resets trust: explicit ALLOWs and snoozes stop applying, policies are kept', async ({ request }) => {
  const up = await headerUpstream(request, 'tc86', { defaultPolicy: 'ALLOW' });
  const other = await headerUpstream(request, 'tc86o', { defaultPolicy: 'ASK' });
  const client = await runOAuthFlow(request, uniq('Client tc86'));
  const mcpClientId = dbAll('select id from McpClient where clientId = ?', client.clientId)[0].id as number;

  const byName = Object.fromEntries(toolRows(up.id).map((t) => [t.name, t]));
  const A = byName['list_items']!; // tool policy ALLOW
  const B = byName['add_item']!; // client-level ALLOW for the calling client
  const C = byName['delete_all']!; // acknowledged, upstream default ALLOW
  expect((await request.patch(`/api/upstreams/${up.id}/tools/${A.id}`, { headers: MATTHIAS, data: { policy: 'ALLOW' } })).status()).toBe(200);
  expect(
    (await request.put(`/api/upstreams/${up.id}/tools/${B.id}/clients/${mcpClientId}`, { headers: MATTHIAS, data: { policy: 'ALLOW' } })).status(),
  ).toBe(200);

  // Before: all three are forwarded, each by its own rule.
  for (const [tool, path] of [
    ['list_items', 'policy:tool'],
    ['add_item', 'policy:client'],
    ['delete_all', 'policy:upstream-default'],
  ] as const) {
    const r = await callTool(request, up.slug, client.accessToken, tool, tool === 'add_item' ? { item: 'x' } : {});
    expect(r.isError ?? false).toBe(false);
    expect(lastAudit(up.id)).toMatchObject({ toolName: tool, outcome: 'FORWARDED', decisionPath: path });
  }

  // A live pause of every scope, on both upstreams.
  const until = iso(new Date(Date.now() + 60 * 60 * 1000));
  const now = iso(new Date());
  for (const id of [up.id, other.id]) {
    const userId = dbAll('select userId from Upstream where id = ?', id)[0].userId;
    for (const [scope, toolName] of [
      ['TOOL', 'list_items'],
      ['READONLY', null],
      ['UPSTREAM', null],
    ] as const) {
      dbRun(
        'insert into Snooze (userId, upstreamId, scope, toolName, mcpClientId, until, createdAt) values (?, ?, ?, ?, ?, ?, ?)',
        userId,
        id,
        scope,
        toolName,
        mcpClientId,
        until,
        now,
      );
    }
  }
  const otherToolsBefore = toolRows(other.id);
  expect(snoozeCount(up.id)).toBe(3);
  expect(snoozeCount(other.id)).toBe(3);

  // Re-point to another tenant (with the value, TC-85).
  const next = newTenant('tc86n');
  const res = await patch(request, up.id, { url: fakeMcpUrl(next), headerValue: FAKE_HEADER_SECRET });
  expect(res.status(), await res.text()).toBe(200);

  expect(snoozeCount(up.id)).toBe(0);
  const after = toolRows(up.id);
  expect(after.every((t) => t.acknowledgedAt === null && t.changedAt !== null)).toBe(true);
  // Policies kept: the tool policy and the client-level rule are still there.
  expect(after.find((t) => t.name === 'list_items')!.policy).toBe('ALLOW');
  expect(dbAll('select policy from ClientToolPolicy where toolId = ? and mcpClientId = ?', B.id, mcpClientId)).toEqual([{ policy: 'ALLOW' }]);

  // The rules view says "Geändert", nothing is allowed.
  const view = await (await request.get(`/api/upstreams/${up.id}/tools`, { headers: MATTHIAS })).json();
  for (const t of view.tools) {
    expect(t).toMatchObject({ isChanged: true, isNew: false, effectivePolicy: 'ASK', path: 'changed-tool' });
  }

  // Every call is held (changed-tool), never forwarded; declined to finish fast.
  for (const tool of ['list_items', 'add_item', 'delete_all']) {
    const call = startCall(request, up.slug, client.accessToken, tool, tool === 'add_item' ? { item: 'y' } : {});
    const p = await waitPending(request, up.id, tool);
    expect(p.rulePath).toBe('changed-tool');
    expect(lastAudit(up.id)).toMatchObject({ toolName: tool, outcome: 'PENDING', decisionPath: 'changed-tool' });
    expect((await decide(request, p.id, { decision: 'deny' })).status()).toBe(200);
    const r = await call;
    expect(r.isError).toBe(true);
  }
  expect((await fakeState(request, next)).calls).toEqual({});

  // Acknowledging A brings its explicit ALLOW back.
  expect((await request.post(`/api/upstreams/${up.id}/tools/${A.id}/acknowledge`, { headers: MATTHIAS })).status()).toBe(200);
  const r = await callTool(request, up.slug, client.accessToken, 'list_items');
  expect(r.isError ?? false).toBe(false);
  expect(lastAudit(up.id)).toMatchObject({ toolName: 'list_items', outcome: 'FORWARDED', decisionPath: 'policy:tool' });
  expect((await fakeState(request, next)).calls).toEqual({ list_items: 1 });

  // The other upstream of the same user is untouched.
  expect(snoozeCount(other.id)).toBe(3);
  expect(toolRows(other.id)).toEqual(otherToolsBefore);

  // Leave nothing behind that a later spec could trip over.
  dbRun('delete from Snooze where upstreamId = ?', other.id);
});

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
}

test('TC-87 UI: a new address for a HEADER upstream asks for the header value again', async ({ page, request }) => {
  const name = uniq('Header UI').replace(/[^A-Za-z0-9 -]/g, '');
  const tenant = newTenant('tc87');
  const up = await createUpstream(request, MATTHIAS, { name, url: fakeMcpUrl(tenant), ...HEADER });
  const next = newTenant('tc87n');

  await page.goto(`/#/regeln/${up.id}`);
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  const sheet = page.getByRole('dialog', { name: 'Upstream bearbeiten' });
  const save = sheet.getByRole('button', { name: 'Speichern' });
  const value = sheet.getByLabel('Header-Wert');
  const hint = sheet.getByText('Neue Adresse: Header-Wert bitte neu eingeben.');

  // Only the name: Save works without a value.
  await sheet.getByLabel('Name', { exact: true }).fill(`${name} B`);
  await expect(hint).toHaveCount(0);
  await expect(save).toBeEnabled();

  // New URL: hint at the value field, Save disabled until a value is entered.
  await sheet.getByLabel('URL').fill(fakeMcpUrl(next));
  await expect(hint).toBeVisible();
  await expect(save).toBeDisabled();
  await noHorizontalScroll(page);
  await value.fill('ein-neuer-wert');
  await expect(save).toBeEnabled();
  // Back to the old URL: the stored value is enough again.
  await value.fill('');
  await sheet.getByLabel('URL').fill(fakeMcpUrl(tenant));
  await expect(hint).toHaveCount(0);
  await expect(save).toBeEnabled();

  await sheet.getByLabel('URL').fill(fakeMcpUrl(next));
  await value.fill('ein-neuer-wert');
  await noHorizontalScroll(page);
  await save.click();
  await expect(sheet).toBeHidden();
  expect(upstreamRow(up.id)).toMatchObject({ url: fakeMcpUrl(next), headerValue: 'ein-neuer-wert' });
  await expect(page.getByRole('heading', { name: `${name} B` })).toBeVisible();
  await expect(page.getByTestId('upstream-address')).toContainText(fakeMcpUrl(next));
  await noHorizontalScroll(page);
});
