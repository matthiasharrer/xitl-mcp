import { describe, expect, it } from 'vitest';
import { splitUnifiedName, unifiedName } from './unifiedNames.js';

describe('unified tool names (ADR-0017)', () => {
  it('round-trips', () => {
    for (const [slug, tool] of [
      ['haushalt', 'add_task'],
      ['a-b', 'x'],
      ['r2', 'get.recipe-v2'],
    ] as const) {
      const name = unifiedName(slug, tool);
      expect(name).toBe(`${slug}_${tool}`);
      expect(splitUnifiedName(name!)).toEqual({ slug, tool });
    }
  });

  it('splits at the first underscore', () => {
    expect(splitUnifiedName('ua_list_items')).toEqual({ slug: 'ua', tool: 'list_items' });
    expect(splitUnifiedName('ua__x')).toEqual({ slug: 'ua', tool: '_x' });
  });

  it('rejects what unifiedName could not produce', () => {
    for (const bad of [
      '',
      'list',
      '_list',
      'ua_',
      'UA_list', // slugs are lower-case
      '-a_list', // slug must start with a letter/digit
      'register_x', // reserved slug
      'token_x',
      'a'.repeat(33) + '_x', // slug too long
      'ua_' + 'x'.repeat(126), // 129 chars
      'ua_li st',
      'ua_lïst',
      'ua_a/b',
    ]) {
      expect(splitUnifiedName(bad), bad).toBeNull();
    }
  });

  it('does not list names that break the MCP rules', () => {
    expect(unifiedName('ua', '')).toBeNull();
    expect(unifiedName('ua', 'has space')).toBeNull();
    expect(unifiedName('ua', 'ü')).toBeNull();
    expect(unifiedName('ua', 'x'.repeat(126))).toBeNull();
    expect(unifiedName('ua', 'x'.repeat(125))).toHaveLength(128);
  });
});
