// ADR-0037 (unit): the in-process server. Real MCP client over the in-memory
// transport, mocked prisma. Covers the tool surface (exactly three, read-only),
// strict arguments (an invalid value never reaches the database), user scoping
// of every query (TC-232) and the whitelist of what leaves (TC-233).
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const auditFindMany = vi.fn();
const auditFindFirst = vi.fn();
const auditGroupBy = vi.fn();
const upstreamFindMany = vi.fn();
const knownGroupBy = vi.fn();
const snoozeFindFirst = vi.fn();
vi.mock('../db.js', () => ({
  prisma: {
    auditEntry: { findMany: auditFindMany, findFirst: auditFindFirst, groupBy: auditGroupBy },
    upstream: { findMany: upstreamFindMany },
    knownTool: { groupBy: knownGroupBy },
    snooze: { findFirst: snoozeFindFirst },
  },
}));
const { buildBuiltinServer } = await import('./server.js');

async function connect(userId: number, threshold: number | null = 0.8) {
  const server = buildBuiltinServer(userId, { threshold });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(c);
  return client;
}
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

beforeEach(() => {
  for (const m of [auditFindMany, auditFindFirst, auditGroupBy, upstreamFindMany, knownGroupBy, snoozeFindFirst]) m.mockReset();
  auditFindMany.mockResolvedValue([]);
  auditFindFirst.mockResolvedValue(null);
});

describe('tool surface (TC-230, TC-238)', () => {
  test('exactly the three read-only tools, with instructions', async () => {
    const client = await connect(1);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_history_entry', 'list_history', 'list_upstreams']);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.description, t.name).toMatch(/Read-only/);
    }
    expect(client.getInstructions()).toMatch(/Read-only/);
  });

  test.each(['set_rule', 'delete_upstream', 'apply_draft', '', 'LIST_HISTORY'])('%j is refused and touches nothing', async (name) => {
    const client = await connect(1);
    const r = await client.callTool({ name, arguments: {} });
    expect(r.isError).toBe(true);
    for (const m of [auditFindMany, auditFindFirst, auditGroupBy, upstreamFindMany, knownGroupBy]) expect(m).not.toHaveBeenCalled();
  });
});

describe('list_history', () => {
  test('invalid arguments: isError, German + English, the database is not asked', async () => {
    const client = await connect(1);
    for (const args of [{ limit: 0 }, { limit: 51 }, { limit: -1 }, { limit: 'x' }, { status: 'nope' }, { from: 'gestern' }, { bogus: 1 }]) {
      const r = await client.callTool({ name: 'list_history', arguments: args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toContain(' / ');
    }
    expect(auditFindMany).not.toHaveBeenCalled();
  });

  test('queries are scoped by the user the server was built for, filters or not', async () => {
    const client = await connect(42);
    await client.callTool({ name: 'list_history', arguments: {} });
    await client.callTool({ name: 'list_history', arguments: { upstream: 'other', tool: 'x', before: 10 } });
    for (const call of auditFindMany.mock.calls) expect(call[0].where.userId).toBe(42);
    expect(auditFindMany.mock.calls[1]![0].where.AND).toContainEqual({ upstream: { is: { slug: 'other', userId: 42 } } });
  });

  test('pages: limit + 1 rows asked, nextBefore is the last id of the page, null at the end', async () => {
    const row = (id: number) => ({
      id, receivedAt: new Date('2026-10-20T10:00:00Z'), toolName: 't', outcome: 'FORWARDED', policy: 'ALLOW', decisionPath: 'snooze+ki',
      pauseCheckChoice: 'gleich', pauseCheckScore: 0.9, pausePurpose: 'p', upstream: { slug: 'u' }, mcpClient: { name: 'c' },
    });
    const client = await connect(1);
    auditFindMany.mockResolvedValueOnce([row(9), row(8), row(7)]);
    const page = JSON.parse(text(await client.callTool({ name: 'list_history', arguments: { limit: 2 } })));
    expect(auditFindMany.mock.calls[0]![0]).toMatchObject({ take: 3, orderBy: { id: 'desc' } });
    expect(page.entries.map((e: { id: number }) => e.id)).toEqual([9, 8]);
    expect(page.nextBefore).toBe(8);
    expect(page.entries[0]).toEqual({
      id: 9, at: '2026-10-20T12:00:00+02:00', upstream: 'u', tool: 't', client: 'c', status: 'forwarded', policy: 'ALLOW', decisionPath: 'snooze+ki',
      pauseCheck: { result: 'match', choice: 'gleich', score: 0.9 }, purpose: 'p',
    });
    auditFindMany.mockResolvedValueOnce([row(5)]);
    const last = JSON.parse(text(await client.callTool({ name: 'list_history', arguments: { limit: 2, before: 8 } })));
    expect(last.nextBefore).toBeNull();
  });

  test('the query selects no result text, intent prompt or diagnostics at all', async () => {
    const client = await connect(1);
    await client.callTool({ name: 'list_history', arguments: {} });
    const select = auditFindMany.mock.calls[0]![0].select as Record<string, unknown>;
    for (const forbidden of ['resultText', 'intentPrompt', 'intentAnswer', 'userAgent', 'headerNames', 'metaKeys', 'traceId', 'clientInfo', 'protocolVersion', 'arguments']) {
      expect(select, forbidden).not.toHaveProperty(forbidden);
    }
  });
});

describe('get_history_entry', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 5, userId: 1, mcpClientId: 3, upstreamId: 2, receivedAt: new Date('2026-10-20T10:00:00Z'), decidedAt: null, finishedAt: null,
    endpoint: '/mcp', toolName: 'archive', arguments: '{"id":4}', policy: 'ASK', decisionPath: 'snooze-ki-mismatch', outcome: 'PENDING', isError: null,
    denyReason: null, pausePurpose: 'Aufräumen', pausePurposeSource: null, pauseCheckChoice: 'richtungswechsel', pauseCheckScore: 0.1,
    pauseCheckInput: 'THE STATE', pauseSnoozeId: null, sperreScore: null, autoScore: null,
    intentStatus: 'FAILED', intentTitle: 'LEAK-TITLE', intentSummary: 'LEAK-SUMMARY', upstream: { slug: 'haushalt', name: 'Haushalt' }, mcpClient: { name: 'c' },
    ...over,
  });

  test('looks the entry up by id AND user (never by id alone); missing = foreign = same text', async () => {
    const client = await connect(7);
    const r = await client.callTool({ name: 'get_history_entry', arguments: { id: 5 } });
    expect(auditFindFirst.mock.calls[0]![0].where).toEqual({ id: 5, userId: 7 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Eintrag nicht gefunden. / Entry not found.');
  });

  test.each([[{}], [{ id: 0 }], [{ id: -1 }], [{ id: 'x' }], [{ id: 1.5 }], [{ id: 1, extra: 1 }]])('invalid %j is an error before any query', async (args) => {
    const client = await connect(1);
    const r = await client.callTool({ name: 'get_history_entry', arguments: args });
    expect(r.isError).toBe(true);
    expect(auditFindFirst).not.toHaveBeenCalled();
  });

  test('the stored Clef input wins; the intent is withheld unless DONE; threshold is reported', async () => {
    const client = await connect(1, 0.8);
    auditFindFirst.mockResolvedValueOnce(entry());
    const out = JSON.parse(text(await client.callTool({ name: 'get_history_entry', arguments: { id: 5 } })));
    expect(out).toMatchObject({
      id: 5, upstream: 'haushalt', arguments: { id: 4 }, status: 'pending', purpose: 'Aufräumen', purposeSource: 'typed',
      pauseCheck: { result: 'mismatch', choice: 'richtungswechsel', score: 0.1, threshold: 0.8 },
      intent: null, clefInput: 'THE STATE', clefInputSource: 'stored',
    });
    expect(JSON.stringify(out)).not.toContain('LEAK');
    auditFindFirst.mockResolvedValueOnce(entry({ intentStatus: 'DONE' }));
    const done = JSON.parse(text(await client.callTool({ name: 'get_history_entry', arguments: { id: 5 } })));
    expect(done.intent).toEqual({ title: 'LEAK-TITLE', summary: 'LEAK-SUMMARY' });
  });

  test('no stored input and no pause link: null / null, nothing reconstructed', async () => {
    const client = await connect(1);
    auditFindFirst.mockResolvedValueOnce(entry({ pauseCheckInput: null }));
    const out = JSON.parse(text(await client.callTool({ name: 'get_history_entry', arguments: { id: 5 } })));
    expect(out.clefInput).toBeNull();
    expect(out.clefInputSource).toBeNull();
    expect(snoozeFindFirst).not.toHaveBeenCalled();
  });

  test('a row under a pause whose anchor still exists is reconstructed with the gate\'s state builder, scoped like the gate', async () => {
    const client = await connect(1);
    auditFindFirst
      .mockResolvedValueOnce(entry({ pauseCheckInput: null, pauseSnoozeId: 42 }))
      .mockResolvedValueOnce({ toolName: 'add', arguments: '{"item":"ANKER"}', intentStatus: 'DONE', intentSummary: 'legt an', upstream: { name: 'Haushalt' } });
    snoozeFindFirst.mockResolvedValueOnce({ anchorAuditId: 3, purpose: 'x' });
    auditFindMany.mockResolvedValueOnce([
      { toolName: 'add', arguments: '{"item":"ZWEI"}', upstream: { name: 'Haushalt' } },
      { toolName: 'add', arguments: '{"item":"EINS"}', upstream: { name: 'Haushalt' } },
    ]);
    const out = JSON.parse(text(await client.callTool({ name: 'get_history_entry', arguments: { id: 5 } })));
    expect(out.clefInputSource).toBe('reconstructed');
    const order = ['ANKER', 'EINS', 'ZWEI', '{"id":4}'].map((m) => out.clefInput.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.clefInput).toContain('Aufräumen');
    expect(snoozeFindFirst.mock.calls[0]![0].where).toEqual({ id: 42, userId: 1 });
    expect(auditFindFirst.mock.calls[1]![0].where).toEqual({ id: 3, userId: 1 });
    expect(auditFindMany.mock.calls[0]![0]).toMatchObject({
      where: { userId: 1, mcpClientId: 3, upstreamId: 2, pauseSnoozeId: 42, id: { lt: 5 } },
      take: 8,
      orderBy: { id: 'desc' },
    });
  });

  test('pause row gone (or without anchor): null / null', async () => {
    const client = await connect(1);
    auditFindFirst.mockResolvedValueOnce(entry({ pauseCheckInput: null, pauseSnoozeId: 42 }));
    snoozeFindFirst.mockResolvedValueOnce(null);
    expect(JSON.parse(text(await client.callTool({ name: 'get_history_entry', arguments: { id: 5 } })))).toMatchObject({ clefInput: null, clefInputSource: null });
    auditFindFirst.mockResolvedValueOnce(entry({ pauseCheckInput: null, pauseSnoozeId: 42 }));
    snoozeFindFirst.mockResolvedValueOnce({ anchorAuditId: null, purpose: null });
    expect(JSON.parse(text(await client.callTool({ name: 'get_history_entry', arguments: { id: 5 } })))).toMatchObject({ clefInput: null, clefInputSource: null });
  });
});

describe('list_upstreams', () => {
  const up = (over: Record<string, unknown>) => ({
    id: 1, slug: 'a', name: 'A', description: null, auth: 'NONE', status: 'CONNECTED', accessToken: null, lastFailureAt: null, pausedAt: null, ...over,
  });

  test('scoped by user; state labels as in the app; whitelist only', async () => {
    upstreamFindMany.mockResolvedValue([
      up({ id: 1, slug: 'aktiv' }),
      up({ id: 2, slug: 'pausiert', pausedAt: new Date(), lastFailureAt: new Date() }),
      up({ id: 3, slug: 'nicht-verbunden', auth: 'OAUTH', status: 'NOT_CONNECTED' }),
      up({ id: 4, slug: 'neu-verbinden', auth: 'OAUTH', status: 'NEEDS_RECONNECT', accessToken: 'SEKRET' }),
      up({ id: 5, slug: 'weg', lastFailureAt: new Date() }),
      up({ id: 6, slug: 'xitl', auth: 'BUILTIN', description: 'd' }),
    ]);
    knownGroupBy.mockResolvedValue([{ upstreamId: 1, _count: { _all: 3 } }]);
    auditGroupBy.mockResolvedValue([{ upstreamId: 1, _max: { receivedAt: new Date('2026-10-20T10:00:00Z') } }]);
    const client = await connect(9);
    const out = JSON.parse(text(await client.callTool({ name: 'list_upstreams', arguments: {} })));
    expect(upstreamFindMany.mock.calls[0]![0].where).toEqual({ userId: 9 });
    expect(upstreamFindMany.mock.calls[0]![0].orderBy[0]).toEqual({ slug: 'asc' });
    expect(knownGroupBy.mock.calls[0]![0].where).toMatchObject({ upstream: { userId: 9 } });
    expect(auditGroupBy.mock.calls[0]![0].where).toMatchObject({ userId: 9 });
    expect(out.upstreams.map((u: { state: string }) => u.state)).toEqual(['aktiv', 'pausiert', 'nicht verbunden', 'neu verbinden', 'nicht erreichbar', 'aktiv']);
    expect(out.upstreams[0]).toEqual({ slug: 'aktiv', name: 'A', description: null, state: 'aktiv', toolCount: 3, lastCallAt: '2026-10-20T12:00:00+02:00' });
    expect(out.upstreams[1]).toMatchObject({ toolCount: 0, lastCallAt: null });
    expect(text({ content: [{ text: JSON.stringify(out) }] })).not.toContain('SEKRET');
    expect(Object.keys(out.upstreams[5]).sort()).toEqual(['description', 'lastCallAt', 'name', 'slug', 'state', 'toolCount']);
  });

  test('takes no arguments', async () => {
    const client = await connect(1);
    const r = await client.callTool({ name: 'list_upstreams', arguments: { all: true } });
    expect(r.isError).toBe(true);
    expect(upstreamFindMany).not.toHaveBeenCalled();
  });
});
