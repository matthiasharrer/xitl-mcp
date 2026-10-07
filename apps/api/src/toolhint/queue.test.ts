// ADR-0031 (TC-152 unit part): the background labeller. Once per (tool,
// version); errors leave the label empty; off (no config / switch off) = no
// request; only rows awaiting review; the write is conditional on the
// definition still being the labelled one.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  pauseCheck: true,
  rows: [] as Record<string, unknown>[],
  writes: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  findWhere: null as unknown,
};
vi.mock('../db.js', () => ({
  prisma: {
    upstream: { findUnique: async () => ({ user: { pauseCheck: state.pauseCheck } }) },
    knownTool: {
      findMany: async ({ where }: { where: unknown }) => {
        state.findWhere = where;
        return state.rows.map((r) => ({ ...r }));
      },
      updateMany: async (q: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.writes.push(q);
        const r = state.rows.find((x) => x.id === q.where.id && x.description === q.where.description);
        if (r) Object.assign(r, q.data);
        return { count: r ? 1 : 0 };
      },
    },
  },
}));
const { HintQueue } = await import('./queue.js');
const { versionKey } = await import('./defs.js');

type Ask = (state: string, q: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
const ok: Ask = async (_s, q) =>
  'risiko' in q
    ? { answers: { risiko: { type: 'choice', choice: 'zerstoeren', probabilities: { lesen: 0.01, aendern: 0.04, zerstoeren: 0.95 } } } }
    : { answers: { injektion: { type: 'noul', noul: 0.9 } } };
function config(ask: Ask, timeoutMs = 1000) {
  const calls: string[] = [];
  return {
    calls,
    cfg: {
      client: { model: undefined, ask: (s: string, q: Record<string, unknown>, sig: AbortSignal) => (calls.push(Object.keys(q)[0]!), ask(s, q, sig)) },
      timeoutMs,
      host: 'clef:8080',
    },
  };
}
const tool = (id: number, description = 'Deletes all.') => ({ id, name: `t${id}`, description, annotations: null, inputSchema: '{"type":"object"}', hintFor: null });

beforeEach(() => {
  state.pauseCheck = true;
  state.rows = [tool(1)];
  state.writes = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('HintQueue (TC-152)', () => {
  it('labels a tool awaiting review once per version', async () => {
    const { cfg, calls } = config(ok);
    const q = new HintQueue(cfg as never, { log: () => {} });
    await q.schedule(5);
    expect(calls).toEqual(['risiko', 'injektion']);
    expect(state.writes[0]!.data).toMatchObject({ hintRisk: 'zerstoeren', hintInjection: 0.9, hintFor: versionKey(tool(1)) });
    // Only rows awaiting review are read.
    expect(state.findWhere).toEqual({ upstreamId: 5, OR: [{ acknowledgedAt: null }, { changedAt: { not: null } }] });
    await q.schedule(5);
    expect(calls).toHaveLength(2); // same version: no new request
    state.rows[0]!.description = 'Deletes everything.';
    await q.schedule(5);
    expect(calls).toHaveLength(4); // new version: labelled again
  });
  it('errors, garbage and timeouts leave the label empty (version done)', async () => {
    for (const ask of [
      async () => {
        throw new Error('HTTP 500');
      },
      async () => ({ answers: { risiko: { choice: 'nope' }, injektion: { noul: 7 } } }),
      (_s: string, _q: unknown, signal: AbortSignal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    ] as Ask[]) {
      state.rows = [tool(1)];
      state.writes = [];
      const { cfg } = config(ask, 20);
      await new HintQueue(cfg as never, { log: () => {} }).schedule(5);
      expect(state.writes[0]!.data).toMatchObject({ hintRisk: null, hintInjection: null, hintFor: versionKey(tool(1)) });
    }
  });
  it('off: no config, or the owner switched Clef off -> no request, nothing written', async () => {
    await new HintQueue(null).schedule(5);
    state.pauseCheck = false;
    const { cfg, calls } = config(ok);
    await new HintQueue(cfg as never).schedule(5);
    expect(calls).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it('the write is conditional on the labelled definition', async () => {
    const { cfg } = config(async (s, q) => {
      state.rows[0]!.description = 'changed meanwhile';
      return ok(s, q, new AbortController().signal);
    });
    await new HintQueue(cfg as never, { log: () => {} }).schedule(5);
    expect(state.writes[0]!.where).toMatchObject({ id: 1, description: 'Deletes all.' });
    expect(state.rows[0]!.hintFor).toBeNull();
  });
});
