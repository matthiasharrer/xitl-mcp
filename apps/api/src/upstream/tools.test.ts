// TC-48 (unit): the tool list taken from an upstream is bounded and sane.
import { describe, expect, test, vi } from 'vitest';

// tools.ts imports the DB client; usableTools itself is pure.
vi.mock('../db.js', () => ({ prisma: {} }));
const { usableTools, isAppOnly, withoutUiMeta } = await import('./tools.js');
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

const withMeta = (name: string, _meta: unknown) => ({ name, inputSchema: { type: 'object' }, _meta }) as never;

describe('MCP Apps view-only tools (TC-240, ADR-0038)', () => {
  test('visibility without "model" is app-only and not usable', () => {
    const out = usableTools([
      withMeta('app', { ui: { resourceUri: 'ui://x/a.html', visibility: ['app'] } }),
      withMeta('both', { ui: { resourceUri: 'ui://x/a.html', visibility: ['model', 'app'] } }),
      withMeta('model', { ui: { visibility: ['model'] } }),
      withMeta('plain', { ui: { resourceUri: 'ui://x/a.html' } }),
      tool('none'),
    ]);
    expect(out.map((t) => t.name)).toEqual(['both', 'model', 'plain', 'none']);
  });

  test('a malformed visibility fails closed (app-only)', () => {
    expect(isAppOnly(withMeta('a', { ui: { visibility: 'model' } }))).toBe(true);
    expect(isAppOnly(withMeta('a', { ui: { visibility: [1] } }))).toBe(true);
    expect(isAppOnly(withMeta('a', { ui: { visibility: null } }))).toBe(true);
    expect(isAppOnly(withMeta('a', { ui: { visibility: [] } }))).toBe(true);
  });

  test('no _meta.ui or a non-object ui is not app-only', () => {
    expect(isAppOnly(tool('a'))).toBe(false);
    expect(isAppOnly(withMeta('a', 'x'))).toBe(false);
    expect(isAppOnly(withMeta('a', { ui: 'x' }))).toBe(false);
  });
});

describe('withoutUiMeta (TC-241, ADR-0038)', () => {
  test('drops ui and the flat ui/resourceUri, keeps other _meta keys', () => {
    const out = withoutUiMeta(withMeta('a', { ui: { resourceUri: 'ui://x' }, 'ui/resourceUri': 'ui://x', other: 1 })) as never as Record<string, unknown>;
    expect(out._meta).toEqual({ other: 1 });
    expect(out.name).toBe('a');
  });

  test('removes _meta entirely when nothing else is left', () => {
    const out = withoutUiMeta(withMeta('a', { ui: { resourceUri: 'ui://x' } })) as never as Record<string, unknown>;
    expect('_meta' in out).toBe(false);
  });

  test('leaves tools without ui meta untouched (same object)', () => {
    const t = withMeta('a', { other: 1 });
    expect(withoutUiMeta(t)).toBe(t);
    const plain = tool('b');
    expect(withoutUiMeta(plain)).toBe(plain);
  });
});
