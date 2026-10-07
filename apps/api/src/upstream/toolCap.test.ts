// TC-89 (unit): KnownTool rows per upstream are capped after a sync. The pure
// selection is tested directly; syncKnownTools runs against a small in-memory
// stand-in for the Prisma calls it makes (unit tests never touch a DB), with
// an injected cap.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fixedClock } from '../lib/clock.js';

interface Row {
  id: number;
  upstreamId: number;
  name: string;
  description: string | null;
  annotations: string | null;
  lastSeenAt: Date;
  acknowledgedAt: Date | null;
  changedAt: Date | null;
}
interface SnoozeRow {
  upstreamId: number;
  scope: 'TOOL' | 'READONLY' | 'UPSTREAM';
  toolName: string | null;
}

const db = { tools: [] as Row[], snoozes: [] as SnoozeRow[], nextId: 1, syncedAt: null as Date | null };

/** Matches the `where` shapes tools.ts uses: plain equality, `{ in }`, `{ lt }`. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; lt?: Date };
      if (c.in) return c.in.includes(v);
      if (c.lt) return v instanceof Date && v.getTime() < c.lt.getTime();
      throw new Error(`unsupported condition on ${k}`);
    }
    return v === cond;
  });
}

const fakePrisma = {
  knownTool: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => db.tools.filter((r) => matches({ ...r }, where)).map((r) => ({ ...r })),
    count: async ({ where }: { where: Record<string, unknown> }) => db.tools.filter((r) => matches({ ...r }, where)).length,
    upsert: async ({ create }: { create: Omit<Row, 'id' | 'changedAt'> }) => {
      db.tools.push({ changedAt: null, ...create, id: db.nextId++ });
    },
    update: async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
      Object.assign(db.tools.find((r) => r.id === where.id)!, data);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = db.tools.filter((r) => matches({ ...r }, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = db.tools.length;
      db.tools = db.tools.filter((r) => !matches({ ...r }, where));
      return { count: before - db.tools.length };
    },
  },
  upstream: {
    findUnique: async () => ({ userId: 1 }),
    // ADR-0034: the toolsSyncedAt stamp (recorded, not matched).
    updateMany: async ({ data }: { data: { toolsSyncedAt?: Date } }) => {
      db.syncedAt = data.toolsSyncedAt ?? null;
      return { count: 1 };
    },
  },
  snooze: {
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = db.snoozes.length;
      db.snoozes = db.snoozes.filter((r) => !matches({ ...r }, where));
      return { count: before - db.snoozes.length };
    },
  },
};

vi.mock('../db.js', () => ({ prisma: fakePrisma }));
const { syncKnownTools, staleToolsToPrune } = await import('./tools.js');
const { MAX_KNOWN_TOOLS_PER_UPSTREAM } = await import('../lib/limits.js');

const UP = 7;
const t0 = Date.UTC(2026, 9, 5, 12, 0);
const at = (min: number) => new Date(t0 + min * 60_000);
const tool = (name: string) => ({ name, inputSchema: { type: 'object' } }) as never;
const names = () => db.tools.map((r) => r.name).sort();

function seed(name: string, lastSeenMin: number, acknowledged = true) {
  db.tools.push({
    id: db.nextId++,
    upstreamId: UP,
    name,
    description: null,
    annotations: null,
    lastSeenAt: at(lastSeenMin),
    acknowledgedAt: acknowledged ? at(lastSeenMin) : null,
    changedAt: null,
  });
}

beforeEach(() => {
  db.tools = [];
  db.snoozes = [];
  db.nextId = 1;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('staleToolsToPrune (TC-89)', () => {
  const row = (id: number, name: string, min: number) => ({ id, name, lastSeenAt: at(min) });

  test('the cap is 1000', () => {
    expect(MAX_KNOWN_TOOLS_PER_UPSTREAM).toBe(1000);
  });

  test('at or under the cap nothing goes', () => {
    expect(staleToolsToPrune([row(1, 'a', 0), row(2, 'b', 1)], new Set(), 2)).toEqual([]);
  });

  test('stale rows go oldest lastSeenAt first, ties by id, down to the cap', () => {
    const rows = [row(1, 'cur', 0), row(2, 's1', 5), row(3, 's2', 1), row(4, 's3', 1), row(5, 's4', 9)];
    expect(staleToolsToPrune(rows, new Set(['cur']), 3)).toEqual([3, 4]);
  });

  test('current rows are never chosen, even if they alone exceed the cap', () => {
    const rows = [row(1, 'a', 0), row(2, 'b', 0), row(3, 'c', 0), row(4, 'old', 5)];
    expect(staleToolsToPrune(rows, new Set(['a', 'b', 'c']), 2)).toEqual([4]);
  });
});

describe('syncKnownTools with a cap (TC-89)', () => {
  test('removes stale rows beyond the cap, oldest lastSeenAt first; current rows stay', async () => {
    seed('cur1', 0);
    seed('stale_old', 1);
    seed('stale_mid', 2);
    seed('stale_new', 3);
    db.snoozes.push({ upstreamId: UP, scope: 'TOOL', toolName: 'stale_old' }, { upstreamId: UP, scope: 'UPSTREAM', toolName: null });
    const clock = fixedClock(at(60));
    await syncKnownTools(UP, [tool('cur1'), tool('cur2')], clock, 3);
    expect(names()).toEqual(['cur1', 'cur2', 'stale_new']);
    // The pruned tool's TOOL pause is gone; other scopes are not about it.
    expect(db.snoozes).toEqual([{ upstreamId: UP, scope: 'UPSTREAM', toolName: null }]);
  });

  test('current rows are never removed, even if they alone exceed the cap', async () => {
    seed('a', 0);
    seed('gone', 1);
    await syncKnownTools(UP, [tool('a'), tool('b'), tool('c')], fixedClock(at(60)), 2);
    expect(names()).toEqual(['a', 'b', 'c']);
  });

  test('under the cap nothing is removed', async () => {
    seed('a', 0);
    seed('gone', 1);
    await syncKnownTools(UP, [tool('a')], fixedClock(at(60)), 2);
    expect(names()).toEqual(['a', 'gone']);
  });

  test('a removed tool that comes back is new (not acknowledged)', async () => {
    seed('a', 0);
    seed('rotated', 1);
    const clock = fixedClock(at(60));
    await syncKnownTools(UP, [tool('a'), tool('b')], clock, 2);
    expect(names()).toEqual(['a', 'b']);
    clock.advance(60_000);
    await syncKnownTools(UP, [tool('a'), tool('rotated')], clock, 3);
    const back = db.tools.find((r) => r.name === 'rotated')!;
    expect(back.acknowledgedAt).toBeNull();
    // ...while a tool that never left keeps its acknowledgement.
    expect(db.tools.find((r) => r.name === 'a')!.acknowledgedAt).not.toBeNull();
  });
});
