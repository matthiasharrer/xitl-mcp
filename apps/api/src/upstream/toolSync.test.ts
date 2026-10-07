// ADR-0031 (TC-149, TC-150 unit parts): syncKnownTools detects inputSchema
// changes, stores first sight after the migration silently, auto-acknowledges
// cosmetic description edits only, and keeps the acknowledged version in prev*.
// Runs against a small in-memory stand-in for the Prisma calls (like
// toolCap.test.ts).
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fixedClock } from '../lib/clock.js';

type Row = Record<string, unknown> & { id: number; name: string };
const db = { tools: [] as Row[], snoozes: [] as { toolName: string }[], nextId: 1, syncedAt: null as Date | null };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k] ?? null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; lt?: Date };
      if (c.in) return c.in.includes(v);
      if (c.lt) return v instanceof Date && v.getTime() < c.lt.getTime();
      throw new Error(`unsupported condition on ${k}`);
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

const fakePrisma = {
  knownTool: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => db.tools.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    count: async ({ where }: { where: Record<string, unknown> }) => db.tools.filter((r) => matches(r, where)).length,
    upsert: async ({ create }: { create: Record<string, unknown> }) => {
      db.tools.push({ changedAt: null, prevDescription: null, prevAnnotations: null, prevInputSchema: null, cosmeticAckAt: null, ...create, id: db.nextId++ } as unknown as Row);
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      Object.assign(db.tools.find((r) => r.id === where.id)!, data);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = db.tools.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    deleteMany: async () => ({ count: 0 }),
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
    deleteMany: async ({ where }: { where: { toolName: string } }) => {
      db.snoozes = db.snoozes.filter((s) => s.toolName !== where.toolName);
      return { count: 0 };
    },
  },
};

vi.mock('../db.js', () => ({ prisma: fakePrisma }));
const { syncKnownTools, onToolsSynced } = await import('./tools.js');
const { schemaText } = await import('../toolhint/defs.js');

const UP = 3;
const clock = fixedClock('2026-10-07T10:00:00Z');
const schemaA = { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] };
const schemaB = { type: 'object', properties: { item: { type: 'string' }, recipient: { type: 'string' } }, required: ['item', 'recipient'] };
const tool = (description: string, inputSchema: unknown = schemaA, annotations?: Record<string, unknown>) =>
  ({ name: 'add_item', description, inputSchema, ...(annotations ? { annotations } : {}) }) as never;
const row = () => db.tools.find((r) => r.name === 'add_item')!;

beforeEach(() => {
  db.tools = [];
  db.snoozes = [{ toolName: 'add_item' }];
  db.nextId = 1;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

async function seedAcknowledged(description = 'Adds an item.', inputSchema: unknown = schemaA) {
  await syncKnownTools(UP, [tool(description, inputSchema)], clock);
  expect(row().acknowledgedAt).toBeInstanceOf(Date); // initial set acknowledged
}

describe('inputSchema change detection (TC-149)', () => {
  test('a new required parameter is a change: changedAt set, ack cleared, prev* = acknowledged, snoozes dropped', async () => {
    await seedAcknowledged();
    await syncKnownTools(UP, [tool('Adds an item.', schemaB)], clock);
    expect(row()).toMatchObject({
      acknowledgedAt: null,
      inputSchema: schemaText(schemaB),
      prevInputSchema: schemaText(schemaA),
      prevDescription: 'Adds an item.',
    });
    expect(row().changedAt).toBeInstanceOf(Date);
    expect(db.snoozes).toEqual([]);
  });
  test('key order alone is not a change', async () => {
    await seedAcknowledged();
    await syncKnownTools(UP, [tool('Adds an item.', { required: ['item'], properties: { item: { type: 'string' } }, type: 'object' })], clock);
    expect(row().changedAt).toBeNull();
  });
  test('first sight after the migration (NULL) is stored silently', async () => {
    await seedAcknowledged();
    row().inputSchema = null;
    await syncKnownTools(UP, [tool('Adds an item.', schemaB)], clock);
    expect(row()).toMatchObject({ changedAt: null, inputSchema: schemaText(schemaB) });
    expect(row().acknowledgedAt).toBeInstanceOf(Date);
  });
  test('a second change keeps the acknowledged version in prev*', async () => {
    await seedAcknowledged();
    await syncKnownTools(UP, [tool('Adds an item.', schemaB)], clock);
    await syncKnownTools(UP, [tool('Adds an item and mails it.', schemaB)], clock);
    expect(row()).toMatchObject({ prevInputSchema: schemaText(schemaA), prevDescription: 'Adds an item.' });
  });
  test('listeners hear every sync', async () => {
    const seen: number[] = [];
    const off = onToolsSynced((id) => seen.push(id));
    await seedAcknowledged();
    off();
    await syncKnownTools(UP, [tool('Adds an item.')], clock);
    expect(seen).toEqual([UP]);
  });
});

describe('cosmetic auto-ack (TC-150)', () => {
  test('whitespace/punctuation/case only: stays acknowledged, recorded as auto-ack:cosmetic', async () => {
    await seedAcknowledged('Adds an item.');
    await syncKnownTools(UP, [tool('adds  an item!')], clock);
    expect(row()).toMatchObject({ description: 'adds  an item!', changedAt: null, prevDescription: 'Adds an item.' });
    expect(row().acknowledgedAt).toBeInstanceOf(Date);
    expect(row().cosmeticAckAt).toBeInstanceOf(Date);
    expect(db.snoozes).toHaveLength(1);
  });
  test.each([
    ['one word', 'Adds one item.'],
    ['a digit', 'Adds an item 2.'],
    ['"nicht"', 'Adds an item nicht.'],
  ])('not cosmetic (%s): changed', async (_, d) => {
    await seedAcknowledged('Adds an item.');
    await syncKnownTools(UP, [tool(d)], clock);
    expect(row().acknowledgedAt).toBeNull();
    expect(row().changedAt).toBeInstanceOf(Date);
  });
  test('cosmetic text but annotations differ: changed', async () => {
    await seedAcknowledged('Adds an item.');
    await syncKnownTools(UP, [tool('adds an item', schemaA, { destructiveHint: true })], clock);
    expect(row().changedAt).toBeInstanceOf(Date);
  });
  test('cosmetic text but schema differs: changed', async () => {
    await seedAcknowledged('Adds an item.');
    await syncKnownTools(UP, [tool('adds an item', schemaB)], clock);
    expect(row().changedAt).toBeInstanceOf(Date);
  });
  test('a tool still awaiting review is never acknowledged by a cosmetic edit', async () => {
    await seedAcknowledged('Adds an item.');
    await syncKnownTools(UP, [tool('Adds an item.', schemaB)], clock); // changed
    await syncKnownTools(UP, [tool('adds an item', schemaB)], clock); // cosmetic on top
    expect(row().acknowledgedAt).toBeNull();
    expect(row().changedAt).toBeInstanceOf(Date);
    expect(row().cosmeticAckAt).toBeNull();
    expect(row().prevDescription).toBe('Adds an item.');
  });
});

// ADR-0034 (TC-204, TC-206 unit parts): every sync stamps toolsSyncedAt; a
// `tools` event only when something the Regeln page shows changed; every
// listed tool's lastSeenAt is the sync time (the vanished rule).
describe('toolsSyncedAt and the tools event (ADR-0034)', () => {
  test('stamped on every sync; event only on a change', async () => {
    const { toolEvents } = await import('../lib/toolEvents.js');
    const seen: number[] = [];
    const off = toolEvents.on((ev) => seen.push(ev.userId));
    try {
      db.syncedAt = null;
      await seedAcknowledged('Adds an item.'); // new tool: a change
      expect(db.syncedAt).toEqual(clock.now());
      expect(seen).toEqual([1]);
      clock.advance(1000);
      await syncKnownTools(UP, [tool('Adds an item.')], clock); // unchanged
      expect(db.syncedAt).toEqual(clock.now());
      expect(seen).toEqual([1]);
      expect(row().lastSeenAt).toEqual(clock.now());
      clock.advance(1000);
      await syncKnownTools(UP, [tool('Adds two items.')], clock); // real change
      expect(seen).toEqual([1, 1]);
      clock.advance(1000);
      await syncKnownTools(UP, [tool('adds two items')], clock); // cosmetic: shown text changed
      expect(seen).toEqual([1, 1, 1]);
    } finally {
      off();
    }
  });
});
