// "Neue Zeitfreigabe" from Freigaben (Matthias 2026-11-07, ADR-0041):
// TC-281 API (/api/running/targets, POST /api/running/pauses), TC-282 UI.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { dbAll, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream } from '../support/upstream.js';
import { pendingList } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Neu ${prefix}`,
});

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Neu ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await runOAuthFlow(request, uniq(`${prefix} A`), user);
  const a = dbAll('select id, name from McpClient where clientId = ?', A.clientId)[0] as { id: number; name: string };
  return { user, up, A: { token: A.accessToken, ...a } };
}
const minutesOf = (row: any) => Math.round((new Date(row.until).getTime() - new Date(row.createdAt).getTime()) / 60_000);
const start = (request: APIRequestContext, user: Identity, data: Record<string, unknown>) => request.post('/api/running/pauses', { headers: user, data });

test.describe('TC-281 Zeitfreigabe ohne gehaltenen Aufruf (API)', () => {
  test('Ziele, Anlegen (ganzer Upstream, kein Anker, kein Zweck), Aufruf läuft durch', async ({ request }) => {
    const ctx = await setup(request, 'np281');
    // A token for ANOTHER upstream must not be offered for this one.
    const other = await connectedUpstream(request, 'np281b', { defaultPolicy: 'ASK', name: uniq('Neu andere') }, ctx.user);
    const tok = (await (await request.post(`/api/upstreams/${other.id}/tokens`, { headers: ctx.user, data: { name: uniq('np281 S') } })).json()) as { client: { id: number } };

    const targets = (await (await request.get('/api/running/targets', { headers: ctx.user })).json()) as { id: number; name: string; clients: { id: number }[] }[];
    const mine = targets.find((t) => t.id === ctx.up.id)!;
    expect(mine.clients.map((c) => c.id)).toEqual([ctx.A.id]);
    expect(targets.find((t) => t.id === other.id)!.clients.map((c) => c.id).sort()).toEqual([ctx.A.id, tok.client.id].sort());

    const res = await start(request, ctx.user, { upstreamId: ctx.up.id, clientId: ctx.A.id, snoozeMinutes: 15 });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.pauses).toHaveLength(1);
    expect(body.pauses[0]).toMatchObject({ effect: 'ALLOW', scope: 'UPSTREAM', toolName: null, purpose: null, client: { id: ctx.A.id }, upstream: { id: ctx.up.id } });
    const row = dbAll('select * from Snooze where upstreamId = ?', ctx.up.id)[0] as any;
    expect(row.anchorAuditId).toBeNull();
    expect(row.purpose).toBeNull();
    expect(minutesOf(row)).toBe(15);

    // A call that would ask now goes through without a held card.
    const r = await callTool(request, ctx.up.slug, ctx.A.token, 'add_item', { item: 'Milch' });
    expect(r.isError ?? false).toBe(false);
    expect((await pendingList(request, ctx.user)).filter((p) => p.upstream.id === ctx.up.id)).toHaveLength(0);

    const midnight = await start(request, ctx.user, { upstreamId: ctx.up.id, clientId: ctx.A.id, snoozeUntilMidnight: true });
    expect(midnight.status()).toBe(201);
  });

  test('ungültig → 400, fremd oder nicht erreichbar → 404, nichts angelegt', async ({ request }) => {
    const ctx = await setup(request, 'np281x');
    const other = await connectedUpstream(request, 'np281y', { defaultPolicy: 'ASK', name: uniq('Neu fremd') }, ctx.user);
    const tok = (await (await request.post(`/api/upstreams/${other.id}/tokens`, { headers: ctx.user, data: { name: uniq('np281 T') } })).json()) as { client: { id: number } };
    const stranger = await setup(request, 'np281z');
    const ok = { upstreamId: ctx.up.id, clientId: ctx.A.id };
    for (const data of [
      ok, // no duration
      { ...ok, snoozeMinutes: 15, snoozeUntilMidnight: true },
      { ...ok, snoozeMinutes: 0 },
      { ...ok, snoozeMinutes: 24 * 60 + 1 },
      { ...ok, snoozeUntilMidnight: false },
      { ...ok, snoozeMinutes: 15, purpose: 'x' },
      { ...ok, snoozeMinutes: 15, scope: 'tool' },
    ]) {
      expect((await start(request, ctx.user, data)).status(), JSON.stringify(data)).toBe(400);
    }
    for (const data of [
      { upstreamId: ctx.up.id, clientId: tok.client.id, snoozeMinutes: 15 }, // token of another upstream
      { upstreamId: stranger.up.id, clientId: ctx.A.id, snoozeMinutes: 15 }, // foreign upstream
      { upstreamId: ctx.up.id, clientId: stranger.A.id, snoozeMinutes: 15 }, // foreign access
      { upstreamId: 999999999, clientId: ctx.A.id, snoozeMinutes: 15 },
    ]) {
      expect((await start(request, ctx.user, data)).status(), JSON.stringify(data)).toBe(404);
    }
    expect(dbAll('select id from Snooze where upstreamId in (?, ?, ?)', ctx.up.id, other.id, stranger.up.id)).toHaveLength(0);
    // Another user's targets never show this upstream.
    const theirs = (await (await request.get('/api/running/targets', { headers: stranger.user })).json()) as { id: number }[];
    expect(theirs.map((t) => t.id)).toEqual([stranger.up.id]);
  });
});

test.describe('TC-282 Neue Zeitfreigabe (UI)', () => {
  test('Button → Dialog → Starten: erscheint in „Läuft gerade“; Handy ohne Querscrollen', async ({ request, page }) => {
    const ctx = await setup(request, 'np282');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    await expect(page.getByText('Keine offenen Freigaben.')).toBeVisible();
    await expect(page.getByTestId('running')).toHaveCount(0);

    await page.getByTestId('new-pause-open').click();
    const dlg = page.getByTestId('new-pause');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('new-pause-upstream').selectOption(String(ctx.up.id));
    await expect(dlg.getByTestId('new-pause-client')).toHaveValue(String(ctx.A.id));
    await expect(dlg.getByTestId('new-pause-hint')).toContainText('Ohne KI-Prüfung');
    await dlg.getByText('1 Std.').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await dlg.getByRole('button', { name: 'Starten' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId('running-summary')).toContainText('Zeitfreigabe');
    const row = dbAll('select * from Snooze where upstreamId = ?', ctx.up.id)[0] as any;
    expect(row.scope).toBe('UPSTREAM');
    expect(minutesOf(row)).toBe(60);

    // Abbrechen creates nothing.
    await page.getByTestId('new-pause-open').click();
    await page.getByTestId('new-pause').getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.getByTestId('new-pause')).toHaveCount(0);
    expect(dbAll('select id from Snooze where upstreamId = ?', ctx.up.id)).toHaveLength(1);
  });
});
