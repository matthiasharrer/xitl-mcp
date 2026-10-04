// TC-48 (unit): the tool list taken from an upstream is bounded and sane.
import { describe, expect, test, vi } from 'vitest';

// tools.ts imports the DB client; usableTools itself is pure.
vi.mock('../db.js', () => ({ prisma: {} }));
const { usableTools } = await import('./tools.js');
const { MAX_UPSTREAM_TOOLS } = await import('../lib/limits.js');

const tool = (name: unknown) => ({ name, inputSchema: { type: 'object' } }) as never;

describe('usableTools (TC-48)', () => {
  test('caps the list at MAX_UPSTREAM_TOOLS, first ones win', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => tool(`t${i}`));
    const out = usableTools(many);
    expect(MAX_UPSTREAM_TOOLS).toBe(500);
    expect(out).toHaveLength(MAX_UPSTREAM_TOOLS);
    expect(out[0]!.name).toBe('t0');
    expect(out.at(-1)!.name).toBe(`t${MAX_UPSTREAM_TOOLS - 1}`);
  });

  test('drops nameless, overlong and duplicate names before counting', () => {
    const out = usableTools([tool(''), tool(42), tool('x'.repeat(129)), tool('a'), tool('a'), tool('b')], 2);
    expect(out.map((t) => t.name)).toEqual(['a', 'b']);
  });

  test('a non-array is an empty list', () => {
    expect(usableTools(null as never)).toEqual([]);
  });
});
