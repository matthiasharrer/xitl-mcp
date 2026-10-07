// A client's default per upstream; "Verbieten" hides the upstream (ADR-0032):
// TC-185…193. The precedence table (TC-184) is a unit test in
// apps/api/src/lib/policy.test.ts. Fresh users per case; clients A and B are
// OAuth (reach every upstream), T an all-upstreams token, S a token of
// another upstream. Fail closed: a hidden upstream must never be listed,
// described or forwarded to, and its refusal must read like an unknown tool.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dbAll, uniq } from '../support/db.js';
import { INITIALIZE, runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeMalice, fakeState, listTools, mcp } from '../support/upstream.js';
import { decide, lastAudit, openStream, pendingList, startCall } from '../support/approval.js';
import { FAKE_CLEF } from '../support/paths.js';
import { firstPushes, settle, subscribe } from '../support/push.js';

test.use({ extraHTTPHeaders: {} });

type Identity = Record<string, string>;
let userN = 0;
const freshUser = (prefix: string): Identity => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Verborgen ${prefix}`,
});
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const PREFIX_LINE = 'Über xitl vermittelt: manche Tools brauchen eine Freigabe. / Proxied by xitl: some tools need approval.';
/** MSG.unknownTool (apps/api/src/lib/proxyText.ts), the exact text. */
const unknownText = (name: string) => `[xitl] Verweigert: Das Tool „${name}“ ist nicht bekannt. / Denied: unknown tool "${name}". List the tools first.`;

async function newClient(request: APIRequestContext, user: Identity, name: string) {
  const c = await runOAuthFlow(request, uniq(name), user);
  const row = dbAll('select id, name from McpClient where clientId = ?', c.clientId)[0];
  return { token: c.accessToken, id: row.id as number, name: row.name as string };
}

async function setup(request: APIRequestContext, prefix: string, defaultPolicy = 'ALLOW') {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy, name: uniq(`Rezepte ${prefix}`), description: `Beschreibung ${prefix} ${Date.now()}` }, user);
  expect((await request.post(`/api/upstreams/${up.id}/tools/refresh`, { headers: user })).status()).toBe(200);
  const A = await newClient(request, user, `${prefix} A`);
  const B = await newClient(request, user, `${prefix} B`);
  return { user, up, A, B };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const view = async (request: APIRequestContext, ctx: Ctx, client?: number | string) => {
  const res = await request.get(`/api/upstreams/${ctx.up.id}/tools${client !== undefined ? `?client=${client}` : ''}`, { headers: ctx.user });
  expect(res.status()).toBe(200);
  return res.json();
};
async function toolId(request: APIRequestContext, ctx: Ctx, name: string) {
  return ((await view(request, ctx)).tools as { id: number; name: string }[]).find((t) => t.name === name)!.id;
}
async function setTool(request: APIRequestContext, ctx: Ctx, name: string, policy: string | null) {
  expect((await request.patch(`/api/upstreams/${ctx.up.id}/tools/${await toolId(request, ctx, name)}`, { headers: ctx.user, data: { policy } })).status()).toBe(200);
}
async function setClientTool(request: APIRequestContext, ctx: Ctx, clientId: number, name: string, policy: string) {
  const res = await request.put(`/api/upstreams/${ctx.up.id}/tools/${await toolId(request, ctx, name)}/clients/${clientId}`, { headers: ctx.user, data: { policy } });
  expect(res.status()).toBe(200);
}
/** The client's default for the upstream; null = "Voreinst." (DELETE). */
async function setDefault(request: APIRequestContext, ctx: Ctx, clientId: number, policy: string | null, upstreamId = ctx.up.id) {
  const res =
    policy === null
      ? await request.delete(`/api/upstreams/${upstreamId}/clients/${clientId}`, { headers: ctx.user })
      : await request.put(`/api/upstreams/${upstreamId}/clients/${clientId}`, { headers: ctx.user, data: { policy } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const defaultRows = (upstreamId: number) => dbAll('select mcpClientId, policy from ClientUpstreamPolicy where upstreamId = ? order by mcpClientId', upstreamId);
const upCalls = async (request: APIRequestContext, ctx: Ctx) => Object.values((await fakeState(request, ctx.up.tenant)).calls).reduce((a, b) => a + b, 0);
const ownTools = (tools: { name: string }[], slug: string) => tools.filter((t) => t.name.startsWith(`${slug}_`)).map((t) => t.name).sort();
async function waitHeldFor(request: APIRequestContext, user: Identity, pred: (p: any) => boolean, known: string[] = []) {
  let found: any;
  await expect
    .poll(async () => {
      found = (await pendingList(request, user)).find((p) => pred(p) && !known.includes(p.id));
      return !!found;
    }, { timeout: 6000, intervals: [50, 100, 200] })
    .toBe(true);
  return found;
}

test.describe('TC-185 API', () => {
  test('PUT setzt, DELETE entfernt; 400 deutsch; fremde Upstreams/Clients 404; S (anderer Upstream) 404; T und A ok', async ({ request }) => {
    const ctx = await setup(request, 'cu185');
    const other = freshUser('cu185o');
    const otherClient = await newClient(request, other, 'cu185 fremd');
    const otherUp = await connectedUpstream(request, 'cu185x', { defaultPolicy: 'ASK' }, other);
    const up2 = await connectedUpstream(request, 'cu185b', { defaultPolicy: 'ASK', name: uniq('Zweiter') }, ctx.user);
    const S = (await (await request.post(`/api/upstreams/${up2.id}/tokens`, { headers: ctx.user, data: { name: uniq('S') } })).json()).client.id as number;
    const T = (await (await request.post('/api/mcp/tokens', { headers: ctx.user, data: { name: uniq('T') } })).json()).client.id as number;

    const set = await setDefault(request, ctx, ctx.A.id, 'ASK');
    expect(set.clientDefaults).toEqual([{ mcpClientId: ctx.A.id, policy: 'ASK' }]);
    expect(set.tools.length).toBeGreaterThan(0);
    expect((await setDefault(request, ctx, T, 'DENY')).clientDefaults).toEqual([
      { mcpClientId: ctx.A.id, policy: 'ASK' },
      { mcpClientId: T, policy: 'DENY' },
    ]);
    // Overwrite, not a second row.
    expect((await setDefault(request, ctx, ctx.A.id, 'AUTO')).clientDefaults).toContainEqual({ mcpClientId: ctx.A.id, policy: 'AUTO' });
    expect(defaultRows(ctx.up.id)).toEqual([
      { mcpClientId: ctx.A.id, policy: 'AUTO' },
      { mcpClientId: T, policy: 'DENY' },
    ]);

    for (const bad of [{ policy: 'always_allow' }, { policy: 'allow' }, { policy: null }, {}, { policy: 7 }]) {
      const res = await request.put(`/api/upstreams/${ctx.up.id}/clients/${ctx.B.id}`, { headers: ctx.user, data: bad });
      expect(res.status(), JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toBe('Die Voreinstellung ist ungültig.');
    }
    // Not found: another user's upstream / client, another user calling, S of another upstream, garbage ids.
    const notFound = [
      request.put(`/api/upstreams/${otherUp.id}/clients/${ctx.A.id}`, { headers: ctx.user, data: { policy: 'DENY' } }),
      request.put(`/api/upstreams/${ctx.up.id}/clients/${otherClient.id}`, { headers: ctx.user, data: { policy: 'DENY' } }),
      request.put(`/api/upstreams/${ctx.up.id}/clients/${ctx.B.id}`, { headers: other, data: { policy: 'DENY' } }),
      request.put(`/api/upstreams/${ctx.up.id}/clients/${S}`, { headers: ctx.user, data: { policy: 'DENY' } }),
      request.put(`/api/upstreams/${ctx.up.id}/clients/abc`, { headers: ctx.user, data: { policy: 'DENY' } }),
      request.delete(`/api/upstreams/${ctx.up.id}/clients/${ctx.A.id}`, { headers: other }),
      request.delete(`/api/upstreams/${ctx.up.id}/clients/${S}`, { headers: ctx.user }),
      request.get(`/api/upstreams/${ctx.up.id}/tools?client=${otherClient.id}`, { headers: ctx.user }),
      request.get(`/api/upstreams/${ctx.up.id}/tools?client=${S}`, { headers: ctx.user }),
      request.get(`/api/upstreams/${ctx.up.id}/tools?client=abc`, { headers: ctx.user }),
      request.get(`/api/upstreams/${ctx.up.id}/tools?client=`, { headers: ctx.user }),
    ];
    for (const res of await Promise.all(notFound)) expect(res.status()).toBe(404);
    expect(defaultRows(ctx.up.id)).toHaveLength(2);
    expect(defaultRows(otherUp.id)).toEqual([]);
    // S on its own upstream is fine (it reaches it).
    expect((await setDefault(request, ctx, S, 'ASK', up2.id)).clientDefaults).toEqual([{ mcpClientId: S, policy: 'ASK' }]);

    // DELETE = Voreinst.
    expect((await setDefault(request, ctx, ctx.A.id, null)).clientDefaults).toEqual([{ mcpClientId: T, policy: 'DENY' }]);
    expect((await setDefault(request, ctx, ctx.A.id, null)).clientDefaults).toEqual([{ mcpClientId: T, policy: 'DENY' }]);
    expect(defaultRows(ctx.up.id)).toEqual([{ mcpClientId: T, policy: 'DENY' }]);
  });

  test('?client= liefert forClient {policy, path, masked} aus evaluatePolicy (ohne Pausen); ohne ?client kein forClient', async ({ request }) => {
    const ctx = await setup(request, 'cu185v', 'ASK');
    await setTool(request, ctx, 'list_items', 'ALLOW');
    await setClientTool(request, ctx, ctx.A.id, 'add_item', 'ALLOW');
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'neu_tool', description: 'Neu.' });
    expect((await request.post(`/api/upstreams/${ctx.up.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(200);

    const forTool = (v: any, name: string) => v.tools.find((t: any) => t.name === name);
    const plain = await view(request, ctx);
    expect(plain.tools.every((t: any) => !('forClient' in t))).toBe(true);
    expect(plain.clientDefaults).toEqual([]);
    expect(forTool(plain, 'add_item').clientPolicies).toEqual([{ mcpClientId: ctx.A.id, policy: 'ALLOW', masked: false }]);

    let v = await view(request, ctx, ctx.A.id);
    expect(forTool(v, 'list_items').forClient).toEqual({ policy: 'ALLOW', path: 'policy:tool', masked: false });
    expect(forTool(v, 'add_item').forClient).toEqual({ policy: 'ALLOW', path: 'policy:client', masked: false });
    expect(forTool(v, 'delete_all').forClient).toEqual({ policy: 'ASK', path: 'policy:upstream-default', masked: false });
    expect(forTool(v, 'neu_tool').forClient).toEqual({ policy: 'ASK', path: 'new-tool', masked: false });

    await setDefault(request, ctx, ctx.A.id, 'ALLOW');
    v = await view(request, ctx, ctx.A.id);
    expect(forTool(v, 'delete_all').forClient).toEqual({ policy: 'ALLOW', path: 'policy:client-upstream', masked: false });
    expect(forTool(v, 'neu_tool').forClient).toEqual({ policy: 'ASK', path: 'new-tool', masked: false });
    // B is untouched.
    expect(forTool(await view(request, ctx, ctx.B.id), 'delete_all').forClient).toEqual({ policy: 'ASK', path: 'policy:upstream-default', masked: false });

    await setDefault(request, ctx, ctx.A.id, 'DENY');
    v = await view(request, ctx, ctx.A.id);
    for (const name of ['list_items', 'delete_all', 'neu_tool']) {
      expect(forTool(v, name).forClient, name).toEqual({ policy: 'DENY', path: 'client-hidden', masked: false });
    }
    expect(forTool(v, 'add_item').forClient).toEqual({ policy: 'DENY', path: 'client-hidden', masked: true });
    expect(forTool(v, 'add_item').clientPolicies).toEqual([{ mcpClientId: ctx.A.id, policy: 'ALLOW', masked: true }]);
    // The global view is unchanged by a client default.
    expect(forTool(v, 'delete_all')).toMatchObject({ effectivePolicy: 'ASK', path: 'policy:upstream-default' });
  });
});

test.describe('TC-186 tools/list verborgen', () => {
  test('A verborgen: /mcp ohne <slug>_…, B sieht alles; neues Tool bleibt für A unsichtbar; /mcp/<slug> leer; Upstream nicht kontaktiert', async ({ request }) => {
    const ctx = await setup(request, 'cu186');
    const slug = ctx.up.slug;
    await setTool(request, ctx, 'list_items', 'ALLOW');
    await setClientTool(request, ctx, ctx.A.id, 'add_item', 'ALLOW');
    const all = [`${slug}_add_item`, `${slug}_delete_all`, `${slug}_list_items`];
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual(all);

    await setDefault(request, ctx, ctx.A.id, 'DENY');
    const before = (await fakeState(request, ctx.up.tenant)).mcpRequests;
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual([]);
    expect(await listTools(request, slug, ctx.A.token)).toEqual([]);
    expect((await fakeState(request, ctx.up.tenant)).mcpRequests).toBe(before);
    expect(ownTools(await listTools(request, null, ctx.B.token), slug)).toEqual(all);

    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'spaeter', description: 'Kam später.' });
    const b = await listTools(request, null, ctx.B.token);
    expect(ownTools(b, slug)).toEqual([...all, `${slug}_spaeter`].sort());
    expect(b.find((t) => t.name === `${slug}_spaeter`)!.description).toContain('[xitl] Erfordert Freigabe');
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual([]);
    expect(await listTools(request, slug, ctx.A.token)).toEqual([]);
  });
});

test.describe('TC-187 Anweisungen', () => {
  test('/mcp: kein Abschnitt, keine Zustandszeile für A (auch bei Störung; B hat sie); /mcp/<slug>: nur die xitl-Zeile', async ({ request }) => {
    const ctx = await setup(request, 'cu187');
    const own = `Eigene Anweisungen ${ctx.up.tenant}: geheim.`;
    await fakeControl(request, ctx.up.tenant, 'config', { instructions: own });
    const up = dbAll('select name, slug, description from Upstream where id = ?', ctx.up.id)[0];
    const initText = async (slug: string | null, token: string) => (await mcp(request, slug, token, 'initialize', INITIALIZE.params)).result.instructions as string;
    const leaks = (text: string) => [up.name, `${up.slug}_`, own, up.description].filter((s) => text.includes(s));

    expect(leaks(await initText(null, ctx.A.token))).toHaveLength(4);
    await setDefault(request, ctx, ctx.A.id, 'DENY');
    const a = await initText(null, ctx.A.token);
    expect(leaks(a)).toEqual([]);
    expect(a.startsWith(PREFIX_LINE)).toBe(true);
    expect(leaks(await initText(null, ctx.B.token))).toHaveLength(4);
    expect(await initText(up.slug, ctx.A.token)).toBe(PREFIX_LINE);
    expect(await initText(up.slug, ctx.B.token)).toContain(own);

    // Failing upstream: B gets the ADR-0022 notice, A nothing at all.
    await fakeMalice(request, ctx.up.tenant, { failMcp: true });
    expect((await request.post(`/api/upstreams/${ctx.up.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(502);
    const bFail = await initText(null, ctx.B.token);
    expect(bFail).toContain(`## ${up.name}`);
    expect(bFail).toContain('nicht erreichbar');
    const aFail = await initText(null, ctx.A.token);
    expect(leaks(aFail)).toEqual([]);
    expect(aFail).not.toContain('nicht erreichbar');
    expect(await initText(up.slug, ctx.A.token)).toBe(PREFIX_LINE);
    await fakeMalice(request, ctx.up.tenant, { failMcp: false });
  });
});

test.describe('TC-188 Aufrufe wie ein unbekanntes Tool', () => {
  test('ALLOW-, Client-ALLOW-, neues und zeitfreigegebenes Tool: sofort der Unbekannt-Text (byte-gleich), kein Halt, kein Push, nichts weitergeleitet, Audit client-hidden', async ({ request, page }) => {
    const ctx = await setup(request, 'cu188');
    const slug = ctx.up.slug;
    await setTool(request, ctx, 'list_items', 'ALLOW');
    await setClientTool(request, ctx, ctx.A.id, 'add_item', 'ALLOW');
    // A live allow pause for A on delete_all (ASK), granted before hiding.
    await setTool(request, ctx, 'delete_all', 'ASK');
    const held = startCall(request, slug, ctx.A.token, 'delete_all');
    const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    expect((await decide(request, p.id, { decision: 'approve', snoozeMinutes: 15, snoozeScope: 'tool' }, ctx.user)).status()).toBe(200);
    expect((await held).isError).toBeFalsy();
    // A new tool, known to xitl (listed by B), never acknowledged.
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'neu_tool', description: 'Neu.' });
    expect(ownTools(await listTools(request, null, ctx.B.token), slug)).toContain(`${slug}_neu_tool`);

    await setDefault(request, ctx, ctx.A.id, 'DENY');
    const endpoint = await subscribe(request, ctx.user);
    const callsBefore = await upCalls(request, ctx);
    const auditsBefore = dbAll('select count(*) as n from AuditEntry where upstreamId = ?', ctx.up.id)[0].n as number;

    // References: really unknown names on both endpoints.
    const nowhere = `nirgends-${Date.now().toString(36)}_add_item`;
    const refUnified = await callTool(request, null, ctx.A.token, nowhere);
    const refSingle = await callTool(request, slug, ctx.B.token, 'gibt_es_nicht');
    expect(refUnified.content[0]!.text).toBe(unknownText(nowhere));
    expect(refSingle.content[0]!.text).toBe(unknownText('gibt_es_nicht'));

    for (const tool of ['list_items', 'add_item', 'neu_tool', 'delete_all', 'gibt_es_nicht']) {
      for (const [where, name] of [[null, `${slug}_${tool}`], [slug, tool]] as const) {
        const t0 = Date.now();
        const r = await callTool(request, where, ctx.A.token, name, { item: 'x' });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r.isError, `${where} ${name}`).toBe(true);
        expect(r.content).toEqual([{ type: 'text', text: unknownText(name) }]);
        const audit = lastAudit(ctx.up.id);
        expect(audit, `${where} ${name}`).toMatchObject({
          toolName: tool,
          mcpClientId: ctx.A.id,
          outcome: 'DENIED',
          policy: 'DENY',
          decisionPath: tool === 'gibt_es_nicht' ? 'unknown-tool' : 'client-hidden',
          approvalId: null,
          endpoint: where === null ? '/mcp' : `/mcp/${slug}`,
        });
        if (tool !== 'gibt_es_nicht') expect(audit.intentStatus).toBe('SKIPPED');
      }
    }
    expect(dbAll('select count(*) as n from AuditEntry where upstreamId = ?', ctx.up.id)[0].n).toBe(auditsBefore + 11);
    expect(await upCalls(request, ctx)).toBe(callsBefore);
    expect((await pendingList(request, ctx.user)).filter((x) => x.upstream.id === ctx.up.id)).toEqual([]);
    await settle();
    expect(firstPushes(endpoint)).toEqual([]);
    // B is unaffected.
    expect((await callTool(request, null, ctx.B.token, `${slug}_list_items`)).isError).toBeFalsy();

    // Verlauf tells the truth.
    const hiddenRow = dbAll("select id from AuditEntry where upstreamId = ? and decisionPath = 'client-hidden' order by id desc limit 1", ctx.up.id)[0];
    await page.setExtraHTTPHeaders(ctx.user);
    await page.goto(`/#/verlauf/${hiddenRow.id}`);
    await expect(page.getByText('für diesen Client verborgen')).toBeVisible();
    expect(await noHScroll(page)).toBe(false);
  });
});

test.describe('TC-189 Nichts lockert es', () => {
  async function clefLog(request: APIRequestContext, ctx: Ctx, question: string) {
    const all = (await (await request.get(`${FAKE_CLEF}/control/log`)).json()) as { body: any; blocks: any[] }[];
    return all.filter((r) => r.body?.questions?.[question] && r.blocks.some((b) => b.upstream === ctx.up.name)).length;
  }

  test('Sperre mit Zweck (Clef: außerhalb), AUTO mit passendem Clef, Client-ALLOW: alles client-hidden; Voreinst. zurück: Tools und Client-Regel wieder da', async ({ request }) => {
    const ctx = await setup(request, 'cu189', 'ASK');
    const slug = ctx.up.slug;
    // Sperre with a purpose on add_item for A.
    const held = startCall(request, slug, ctx.A.token, 'add_item', { id: 21 });
    const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    expect((await decide(request, p.id, { decision: 'deny', snoozeMinutes: 15, snoozeScope: 'upstream', purpose: 'keine Artikel hinzufügen' }, ctx.user)).status()).toBe(200);
    expect((await held).isError).toBe(true);
    // Sanity: before hiding, a call Clef judges outside the Sperre is asked.
    const asked = startCall(request, slug, ctx.A.token, 'list_items', { __sperre: '0.99' });
    const q = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    expect(q.rulePath).toBe('snooze-deny-ki-ask');
    expect((await decide(request, q.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await asked;

    await setDefault(request, ctx, ctx.A.id, 'DENY');
    const sperreBefore = await clefLog(request, ctx, 'ausserhalb');
    let r = await callTool(request, slug, ctx.A.token, 'list_items', { __sperre: '0.99' });
    expect(r.content[0]!.text).toBe(unknownText('list_items'));
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'client-hidden', outcome: 'DENIED', sperreScore: null });
    expect(await clefLog(request, ctx, 'ausserhalb')).toBe(sperreBefore);

    // AUTO default with a rule and a passing Clef answer.
    const patched = await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { defaultPolicy: 'AUTO', autoRule: 'Alles ist ok.' } });
    expect(patched.status(), await patched.text()).toBe(200);
    await request.delete(`/api/upstreams/${ctx.up.id}/snoozes/${dbAll('select id from Snooze where upstreamId = ?', ctx.up.id)[0].id}`, { headers: ctx.user });
    const autoBefore = await clefLog(request, ctx, 'erlaubt');
    r = await callTool(request, null, ctx.A.token, `${slug}_list_items`, { __auto: '0.99' });
    expect(r.content[0]!.text).toBe(unknownText(`${slug}_list_items`));
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'client-hidden', autoScore: null });
    expect(await clefLog(request, ctx, 'erlaubt')).toBe(autoBefore);
    // A client tool ALLOW is masked, not applied.
    await setClientTool(request, ctx, ctx.A.id, 'add_item', 'ALLOW');
    const calls0 = await upCalls(request, ctx);
    r = await callTool(request, slug, ctx.A.token, 'add_item', { item: 'x' });
    expect(r.content[0]!.text).toBe(unknownText('add_item'));
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'client-hidden' });
    expect(await upCalls(request, ctx)).toBe(calls0);
    expect(dbAll('select policy from ClientToolPolicy where mcpClientId = ?', ctx.A.id)).toEqual([{ policy: 'ALLOW' }]);

    // Back to Voreinst.: tools listed again, the client rule applies again.
    await setDefault(request, ctx, ctx.A.id, null);
    expect(ownTools(await listTools(request, null, ctx.A.token), slug)).toEqual([`${slug}_add_item`, `${slug}_delete_all`, `${slug}_list_items`]);
    r = await callTool(request, slug, ctx.A.token, 'add_item', { item: 'y' });
    expect(r.isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'policy:client', outcome: 'FORWARDED' });
  });
});

test.describe('TC-190 Gehaltene Aufrufe', () => {
  test('DENY beendet As 2 gehaltene Aufrufe am Upstream (+denied:client-hidden, Unbekannt-Text, Karten weg); andere bleiben; ALLOW/ASK/AUTO lassen sie', async ({ request }) => {
    const ctx = await setup(request, 'cu190', 'ASK');
    const slug = ctx.up.slug;
    const up2 = await connectedUpstream(request, 'cu190b', { defaultPolicy: 'ASK', name: uniq('Zweiter') }, ctx.user);
    expect((await request.post(`/api/upstreams/${up2.id}/tools/refresh`, { headers: ctx.user })).status()).toBe(200);
    const stream = await openStream(ctx.user);

    const known: string[] = [];
    const hold = async (s: string | null, token: string, name: string, pred: (p: any) => boolean) => {
      const res = startCall(request, s as string, token, name, { item: 'h' });
      const p = await waitHeldFor(request, ctx.user, pred, known);
      known.push(p.id);
      return { res, id: p.id as string };
    };
    const a1 = await hold(slug, ctx.A.token, 'add_item', (p) => p.upstream.id === ctx.up.id && p.tool === 'add_item');
    const a2 = await hold(null, ctx.A.token, `${slug}_list_items`, (p) => p.upstream.id === ctx.up.id && p.tool === 'list_items');
    const a3 = await hold(up2.slug, ctx.A.token, 'add_item', (p) => p.upstream.id === up2.id);
    const b1 = await hold(slug, ctx.B.token, 'add_item', (p) => p.upstream.id === ctx.up.id && p.tool === 'add_item');

    for (const pol of ['ALLOW', 'ASK', 'AUTO']) {
      await setDefault(request, ctx, ctx.A.id, pol);
      await settle(200);
      expect((await pendingList(request, ctx.user)).map((p) => p.id).sort()).toEqual(known.slice().sort());
    }
    const callsBefore = await upCalls(request, ctx);
    await setDefault(request, ctx, ctx.A.id, 'DENY');
    const r1 = await a1.res;
    const r2 = await a2.res;
    expect(r1.content).toEqual([{ type: 'text', text: unknownText('add_item') }]);
    expect(r2.content).toEqual([{ type: 'text', text: unknownText(`${slug}_list_items`) }]);
    for (const id of [a1.id, a2.id]) {
      expect(dbAll('select outcome, decisionPath from AuditEntry where approvalId = ?', id)[0]).toEqual({ outcome: 'DENIED', decisionPath: 'policy:upstream-default+denied:client-hidden' });
    }
    expect(await upCalls(request, ctx)).toBe(callsBefore);
    expect((await pendingList(request, ctx.user)).map((p) => p.id).sort()).toEqual([a3.id, b1.id].sort());
    await expect.poll(() => stream.events.filter((e) => e.event === 'resolved').map((e) => e.data.id).sort()).toEqual([a1.id, a2.id].sort());
    await stream.close();

    for (const id of [a3.id, b1.id]) expect((await decide(request, id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
    await Promise.all([a3.res, b1.res]);
  });
});

test.describe('TC-191 ALLOW/ASK/AUTO als Client-Voreinstellung', () => {
  test('Upstream ASK, A ALLOW: A weitergeleitet (policy:client-upstream), B gehalten; Tool-Regel ASK und neues Tool halten A', async ({ request }) => {
    const ctx = await setup(request, 'cu191', 'ASK');
    const slug = ctx.up.slug;
    await setDefault(request, ctx, ctx.A.id, 'ALLOW');
    let r = await callTool(request, slug, ctx.A.token, 'list_items');
    expect(r.isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'policy:client-upstream', outcome: 'FORWARDED', policy: 'ALLOW' });
    // A's list: no stamp; B's list: stamped.
    expect((await listTools(request, slug, ctx.A.token)).find((t) => t.name === 'list_items')!.description).not.toContain('[xitl]');
    expect((await listTools(request, slug, ctx.B.token)).find((t) => t.name === 'list_items')!.description).toContain('[xitl]');

    const known: string[] = [];
    const heldThenDeny = async (token: string, tool: string, path: string) => {
      const res = startCall(request, slug, token, tool, { item: 'q' });
      const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id && x.tool === tool, known);
      known.push(p.id);
      expect(p.rulePath).toBe(path);
      expect((await decide(request, p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
      expect((await res).isError).toBe(true);
    };
    await heldThenDeny(ctx.B.token, 'list_items', 'policy:upstream-default');
    await setTool(request, ctx, 'add_item', 'ASK');
    await heldThenDeny(ctx.A.token, 'add_item', 'policy:tool');
    await fakeControl(request, ctx.up.tenant, 'tools', { name: 'neu_tool', description: 'Neu.' });
    expect((await listTools(request, slug, ctx.A.token)).find((t) => t.name === 'neu_tool')!.description).toContain('[xitl]');
    await heldThenDeny(ctx.A.token, 'neu_tool', 'new-tool');
  });

  test('A AUTO mit Regel: Clef passt → weitergeleitet (auto), knapp → gefragt; ohne Regel → gefragt', async ({ request }) => {
    const ctx = await setup(request, 'cu191a', 'ASK');
    const slug = ctx.up.slug;
    expect((await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { autoRule: 'Lesen ist ok.' } })).status()).toBe(200);
    await setDefault(request, ctx, ctx.A.id, 'AUTO');
    let r = await callTool(request, slug, ctx.A.token, 'list_items', { __auto: '0.95' });
    expect(r.isError).toBeFalsy();
    expect(lastAudit(ctx.up.id)).toMatchObject({ decisionPath: 'auto', outcome: 'FORWARDED', autoScore: 0.95 });
    const known: string[] = [];
    const asks = async (path: string) => {
      const res = startCall(request, slug, ctx.A.token, 'list_items', { __auto: '0.2' });
      const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id, known);
      known.push(p.id);
      expect(p.rulePath).toBe(path);
      expect((await decide(request, p.id, { decision: 'deny' }, ctx.user)).status()).toBe(200);
      await res;
    };
    await asks('auto-ask');
    expect((await request.patch(`/api/upstreams/${ctx.up.id}`, { headers: ctx.user, data: { autoRule: null } })).status()).toBe(200);
    await asks('auto-norule');
  });

  test('Upstream ALLOW, A ASK: A gehalten (Stempel in tools/list), B weitergeleitet', async ({ request }) => {
    const ctx = await setup(request, 'cu191b', 'ALLOW');
    const slug = ctx.up.slug;
    await setDefault(request, ctx, ctx.A.id, 'ASK');
    expect((await listTools(request, null, ctx.A.token)).find((t) => t.name === `${slug}_add_item`)!.description).toContain('[xitl] Erfordert Freigabe');
    expect((await listTools(request, null, ctx.B.token)).find((t) => t.name === `${slug}_add_item`)!.description).not.toContain('[xitl]');
    const res = startCall(request, slug, ctx.A.token, 'add_item', { item: 'a' });
    const p = await waitHeldFor(request, ctx.user, (x) => x.upstream.id === ctx.up.id);
    expect(p.rulePath).toBe('policy:client-upstream');
    expect((await callTool(request, slug, ctx.B.token, 'add_item', { item: 'b' })).isError).toBeFalsy();
    expect((await decide(request, p.id, { decision: 'approve' }, ctx.user)).status()).toBe(200);
    expect((await res).isError).toBeFalsy();
    expect(dbAll('select decisionPath from AuditEntry where approvalId = ?', p.id)[0].decisionPath).toBe('policy:client-upstream+approved:page');
  });
});

test.describe('TC-192 UI Regeln „Gilt für“', () => {
  test('Client-Ansicht: Voreinstellung, Quelle pro Tool, Verbieten maskiert ohne Dialog; Auswahl übersteht Reload; 390×844', async ({ request, page }) => {
    const ctx = await setup(request, 'ui192', 'ASK');
    await setTool(request, ctx, 'list_items', 'ALLOW');
    await setClientTool(request, ctx, ctx.A.id, 'delete_all', 'DENY');
    await page.setExtraHTTPHeaders(ctx.user);
    page.on('dialog', () => {
      throw new Error('no dialog expected');
    });
    await page.goto(`/#/regeln/${ctx.up.id}`);
    const scope = page.getByRole('radiogroup', { name: 'Gilt für' });
    await expect(scope.getByText('Alle Clients')).toBeVisible();
    await scope.locator(`[data-scope-client="${ctx.A.id}"]`).click();
    await expect(page.getByTestId('precedence')).toContainText('Client-Regel > Tool-Regel > Client-Voreinst. > Upstream-Voreinst.');
    const row = (tool: string) => page.locator(`li[data-tool="${tool}"]`).getByTestId('for-client');
    await expect(row('list_items')).toHaveText('Erlauben · Tool-Regel');
    await expect(row('add_item')).toHaveText('Fragen · Upstream-Voreinst.');
    await expect(row('delete_all')).toHaveText('Verbieten · Client-Regel');
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc192-client.png'), fullPage: true });

    // Client default Erlauben: untouched tools follow it, the tool rule still wins.
    const def = page.getByRole('radiogroup', { name: `Voreinstellung für ${ctx.A.name}` });
    await def.getByText('Erlauben').click();
    await expect(row('add_item')).toHaveText('Erlauben · Client-Voreinst.');
    expect(defaultRows(ctx.up.id)).toEqual([{ mcpClientId: ctx.A.id, policy: 'ALLOW' }]);

    // Verbieten: no dialog, everything "Verborgen", the client rule masked.
    await def.getByText('Verbieten').click();
    await expect(page.getByTestId('hidden-note')).toHaveText(`Für ${ctx.A.name} unsichtbar: keine Tools, kein Abschnitt in den Anweisungen`);
    for (const t of ['list_items', 'add_item', 'delete_all']) await expect(row(t)).toHaveText('Verborgen · Client-Voreinst.');
    await expect(page.locator('li[data-tool="delete_all"]').getByTestId('masked')).toBeVisible();
    // masked, not reset: the rule is still stored
    expect(dbAll('select policy from ClientToolPolicy where mcpClientId = ?', ctx.A.id)).toEqual([{ policy: 'DENY' }]);
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc192-verborgen.png'), fullPage: true });

    // The selection survives a reload.
    await page.reload();
    await expect(page.getByTestId('hidden-note')).toBeVisible();

    // Alle Clients: the masked rule shows in "Pro Client".
    await scope.getByText('Alle Clients').click();
    const tool = page.locator('li[data-tool="delete_all"]');
    await tool.locator('details.client-overrides summary').click();
    await expect(tool.getByTestId('masked')).toHaveText(`wirkungslos: Upstream für ${ctx.A.name} verborgen`);

    // Touch targets of the switches ≥ 44 px.
    for (const l of await page.locator('[role="radiogroup"] label').all()) {
      const b = await l.boundingBox();
      if (b) expect(b.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('TC-193 Zeile auf der Client-Seite', () => {
  test('„Sieht: … · Verborgen: …“, Verborgen-Teil nur wenn nötig; nur eigene Daten', async ({ request, page }) => {
    const ctx = await setup(request, 'ui193');
    const other = await connectedUpstream(request, 'ui193b', { defaultPolicy: 'ALLOW', name: uniq('Haushalt ui193') }, ctx.user);
    const list = async () => (await (await request.get('/api/mcp/clients', { headers: ctx.user })).json()) as any[];
    let a = (await list()).find((c) => c.id === ctx.A.id);
    expect([...a.sees].sort()).toEqual([ctx.up.name, other.name].sort());
    expect(a.hidden).toEqual([]);
    await setDefault(request, ctx, ctx.A.id, 'DENY');
    a = (await list()).find((c) => c.id === ctx.A.id);
    expect(a.sees).toEqual([other.name]);
    expect(a.hidden).toEqual([ctx.up.name]);
    // another user sees none of it
    const stranger = freshUser('ui193x');
    expect(((await (await request.get('/api/mcp/clients', { headers: stranger })).json()) as any[]).find((c) => c.id === ctx.A.id)).toBeUndefined();

    await page.setExtraHTTPHeaders(ctx.user);
    // on each client's own page
    await page.goto(`/#/client/${ctx.A.id}`);
    await expect(page.getByTestId('client-sees')).toHaveText(`Sieht: ${other.name} · Verborgen: ${ctx.up.name}`);
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('tc193-client.png'), fullPage: true });
    // B: nothing hidden, no "Verborgen" part
    await page.goto(`/#/client/${ctx.B.id}`);
    await expect(page.getByTestId('client-sees')).toBeVisible();
    await expect(page.getByTestId('client-sees')).not.toContainText('Verborgen');
  });
});
