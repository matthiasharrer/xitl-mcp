// Deny reason (ADR-0036): TC-223…227. An optional reason the human gives when
// denying a held call; it reaches the agent in the decline text and the audit
// row, only from /api, never from the agent.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { connectedUpstream } from '../support/upstream.js';
import { decide, pendingList, startCall, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Tester ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ASK', name: uniq(`Tester ${prefix}`) }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const c = await runOAuthFlow(request, uniq(`${prefix} A`), user);
  return { user, up, token: c.accessToken };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const auditOf = (approvalId: string) => dbAll('select * from AuditEntry where approvalId = ?', approvalId)[0];
const textOf = (r: { content: { text: string }[] }) => r.content[0].text;
const PLAIN = (up: string) => `[xitl] Abgelehnt: ${up} hat den Aufruf von „add_item“ abgelehnt. / Declined: ${up} declined the call to "add_item".`;

/** Holds add_item, returns the pending call and the promise of the agent's result. */
async function hold(request: APIRequestContext, ctx: Ctx, args: Record<string, unknown> = { item: 'x' }) {
  const held = startCall(request, ctx.up.slug, ctx.token, 'add_item', args);
  const p = await waitPending(request, ctx.up.id, 'add_item', ctx.user);
  return { p, held };
}

test.describe('TC-223 One tap stays one tap', () => {
  test('plain deny: text without Grund, denyReason null, UI request without reason', async ({ page, request }) => {
    const ctx = await setup(request, 'dr223');
    await page.context().setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const { p, held } = await hold(request, ctx);
    const card = page.locator(`[data-approval="${p.id}"]`);
    let body: any = null;
    await page.route(`**/api/approvals/${p.id}`, (route) => {
      if (route.request().method() === 'POST') body = route.request().postDataJSON();
      return route.continue();
    });
    await expect(card.getByRole('button', { name: 'Ablehnen', exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Ablehnen', exact: true }).click();
    const r = await held;
    expect(body).toEqual({ decision: 'deny', via: 'page' });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).not.toContain('Grund');
    expect(text).not.toContain('Reason');
    expect(text).toMatch(/^\[xitl\] Abgelehnt: .+ hat den Aufruf von „add_item“ abgelehnt\. \/ Declined: .+ declined the call to "add_item"\.$/);
    expect(auditOf(p.id)).toMatchObject({ outcome: 'DENIED', denyReason: null });
  });

  test('API: no reason, whitespace-only and empty reason all give the plain text', async ({ request }) => {
    const ctx = await setup(request, 'dr223b');
    for (const extra of [{}, { reason: '   ' }, { reason: '' }]) {
      const { p, held } = await hold(request, ctx);
      expect((await decide(request, p.id, { decision: 'deny', ...extra }, ctx.user)).status()).toBe(200);
      const text = textOf(await held);
      expect(text).not.toContain('Grund');
      expect(text).toBe(PLAIN(text.match(/Abgelehnt: (.+?) hat/)![1]));
      expect(auditOf(p.id).denyReason).toBeNull();
    }
  });
});

test.describe('TC-224 Chips + free text', () => {
  test('390×844: chips toggle, button label, agent text, audit row, Verlauf detail', async ({ page, request }) => {
    const ctx = await setup(request, 'dr224');
    await page.context().setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const { p, held } = await hold(request, ctx);
    const card = page.locator(`[data-approval="${p.id}"]`);
    const row = card.getByTestId('deny-reason');
    await expect(row).toBeVisible();
    await expect(row.getByText('Grund fürs Ablehnen (optional)')).toBeVisible();
    const chip = (k: string) => row.getByTestId(`deny-reason-chip-${k}`);
    for (const [k, label] of [['wrong-tool', 'Falsches Tool'], ['no-retry', 'Nicht nochmal versuchen'], ['ask-first', 'Erst im Chat nachfragen'], ['custom', 'Eigener Grund …']]) {
      await expect(chip(k)).toHaveText(label);
      await expect(chip(k)).toHaveAttribute('aria-pressed', 'false');
      expect((await chip(k).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(row.getByTestId('deny-reason-text')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Ablehnen', exact: true })).toBeVisible();

    await chip('wrong-tool').click();
    await expect(card.getByRole('button', { name: 'Ablehnen mit Grund' })).toBeVisible();
    // Turning it off again removes the reason and the label.
    await chip('wrong-tool').click();
    await expect(card.getByRole('button', { name: 'Ablehnen', exact: true })).toBeVisible();

    await chip('wrong-tool').click();
    await chip('no-retry').click();
    await expect(chip('no-retry')).toHaveAttribute('aria-pressed', 'true');
    await chip('custom').click();
    const input = row.getByTestId('deny-reason-text');
    await expect(input).toHaveAttribute('maxlength', '120');
    await input.fill('  lieber add_task  ');
    expect(await noHScroll(page)).toBe(false);
    await card.getByRole('button', { name: 'Ablehnen mit Grund' }).click();
    await expect(page.getByText('Abgelehnt, mit Grund')).toBeVisible();

    const reason = 'Falsches Tool; Nicht nochmal versuchen; lieber add_task';
    const text = textOf(await held);
    expect(text).toContain(`Grund: „${reason}“`);
    expect(text).toContain(`Reason: "${reason}"`);
    const a = auditOf(p.id);
    expect(a).toMatchObject({ outcome: 'DENIED', denyReason: reason });
    expect(a.resultText).toBe(text);

    const list = await (await request.get('/api/audit', { headers: ctx.user })).json();
    expect(list.entries.find((e: any) => e.id === a.id)).toMatchObject({ denyReason: reason });
    await page.goto(`/#/verlauf/${a.id}`);
    await expect(page.getByTestId('deny-reason-line')).toHaveText(`Grund: ${reason}`);
    expect(await noHScroll(page)).toBe(false);
  });

  test('free text only counts while "Eigener Grund …" is on', async ({ page, request }) => {
    const ctx = await setup(request, 'dr224b');
    await page.context().setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const { p, held } = await hold(request, ctx);
    const card = page.locator(`[data-approval="${p.id}"]`);
    await card.getByTestId('deny-reason-chip-custom').click();
    await card.getByTestId('deny-reason-text').fill('nur Text');
    await card.getByTestId('deny-reason-chip-custom').click();
    await card.getByTestId('deny-reason-chip-ask-first').click();
    await card.getByRole('button', { name: 'Ablehnen mit Grund' }).click();
    expect(textOf(await held)).toContain('Grund: „Erst im Chat nachfragen“');
    expect(auditOf(p.id).denyReason).toBe('Erst im Chat nachfragen');
  });
});

test.describe('TC-225 With a Sperre', () => {
  test('blocked text ends with the reason; the call settled by the Sperre gets none', async ({ page, request }) => {
    const ctx = await setup(request, 'dr225');
    await page.context().setExtraHTTPHeaders(ctx.user);
    await page.goto('/');
    const first = await hold(request, ctx, { item: 'one' });
    // A second held call of the same tool, settled by the Sperre.
    const second = startCall(request, ctx.up.slug, ctx.token, 'add_item', { item: 'two' });
    await expect.poll(async () => (await pendingList(request, ctx.user)).filter((x) => x.upstream.id === ctx.up.id).length).toBe(2);
    const card = page.locator(`[data-approval="${first.p.id}"]`);
    await card.getByTestId('deny-reason-chip-no-retry').click();
    await card.getByRole('button', { name: 'Ablehnen · 15 Min. sperren' }).click();
    await expect(page.getByText(/Abgelehnt, 15 Minuten gesperrt: add_item, mit Grund/)).toBeVisible();

    const t1 = textOf(await first.held);
    expect(t1).toMatch(/^\[xitl\] Verweigert: Der Nutzer hat „add_item“ für diesen Client bis .* gesperrt\. Bitte bis dahin nicht erneut versuchen\. Grund: „Nicht nochmal versuchen“ \/ Denied: .*Do not retry before then\. Reason: "Nicht nochmal versuchen"$/);
    expect(auditOf(first.p.id).denyReason).toBe('Nicht nochmal versuchen');
    expect(dbAll('select effect, scope, toolName from Snooze where upstreamId = ?', ctx.up.id)).toEqual([{ effect: 'DENY', scope: 'TOOL', toolName: 'add_item' }]);

    const t2 = textOf(await second);
    // Settled via the Sperre (not itself blocked): the plain decline text.
    expect(t2).toMatch(/^\[xitl\] Abgelehnt: .+ hat den Aufruf von „add_item“ abgelehnt\. \/ Declined: .+ declined the call to "add_item"\.$/);
    expect(t2).not.toContain('Grund');
    expect(t2).not.toContain('Reason');
    const settled = dbAll('select * from AuditEntry where upstreamId = ? and decisionPath like ? ', ctx.up.id, '%denied:pause');
    expect(settled).toHaveLength(1);
    expect(settled[0].denyReason).toBeNull();
  });
});

test.describe('TC-226 API guards (fail closed)', () => {
  test('bad reasons give 400 and the call stays held; foreign user 404; then a valid reason works', async ({ request }) => {
    const ctx = await setup(request, 'dr226');
    const other = freshUser('dr226o');
    const { p, held } = await hold(request, ctx);
    const stillHeld = async () => expect((await pendingList(request, ctx.user)).some((x) => x.id === p.id)).toBe(true);
    for (const bad of [
      { decision: 'approve', reason: 'nein' },
      { decision: 'deny', reason: 'x'.repeat(201) },
      { decision: 'deny', reason: 'zwei\nZeilen' },
      { decision: 'deny', reason: 'nul\u0000' },
      { decision: 'deny', reason: 'tab\there' },
      { decision: 'deny', reason: 5 },
      { decision: 'deny', reason: null },
      { decision: 'deny', reason: ['a'] },
      { decision: 'approve', reason: 'nein', snoozeMinutes: 15, snoozeScope: 'tool' },
    ]) {
      const res = await decide(request, p.id, bad, ctx.user);
      expect(res.status(), JSON.stringify(bad)).toBe(400);
      await stillHeld();
    }
    expect((await (await decide(request, p.id, { decision: 'approve', reason: 'nein' }, ctx.user)).json()).error).toBe('Ein Grund gibt es nur beim Ablehnen.');
    expect((await decide(request, p.id, { decision: 'deny', reason: 'fremd' }, other)).status()).toBe(404);
    await stillHeld();
    // 200 chars is fine (the limit counts what is sent, before trimming).
    expect((await decide(request, p.id, { decision: 'deny', reason: 'ä'.repeat(200) }, ctx.user)).status()).toBe(200);
    const text = textOf(await held);
    expect(text).toContain(`Grund: „${'ä'.repeat(200)}“`);
    expect(auditOf(p.id).denyReason).toBe('ä'.repeat(200));
    // Nothing was forwarded.
    expect(dbAll('select outcome from AuditEntry where upstreamId = ?', ctx.up.id)).toEqual([{ outcome: 'DENIED' }]);
  });
});

test.describe('TC-227 The agent cannot set it', () => {
  test('arguments / _meta named reason and a push deny: plain text, denyReason null', async ({ request }) => {
    const ctx = await setup(request, 'dr227');
    const a = await hold(request, ctx, { item: 'x', reason: 'Grund: x', denyReason: 'Grund: y' });
    expect((await decide(request, a.p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    const ta = textOf(await a.held);
    expect(ta).not.toContain('Grund');
    expect(ta).not.toContain('Reason');
    expect(auditOf(a.p.id).denyReason).toBeNull();

    // Lock-screen action: only decision + via.
    const b = await hold(request, ctx);
    expect((await decide(request, b.p.id, { decision: 'deny', via: 'push' }, ctx.user)).status()).toBe(200);
    const tb = textOf(await b.held);
    expect(tb).not.toContain('Grund');
    expect(auditOf(b.p.id)).toMatchObject({ decisionPath: expect.stringContaining('denied:push'), denyReason: null });
  });
});
