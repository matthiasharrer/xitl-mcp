// Snooze scopes (TC-76 unit part): which rows cover which tool.
import { describe, expect, it } from 'vitest';
import { covers, isReadOnly, latestCovering } from './snooze.js';

const d = (m: number) => new Date(Date.UTC(2026, 9, 5, 12, m));

describe('snooze scopes', () => {
  it('TOOL covers exactly its tool', () => {
    expect(covers({ scope: 'TOOL', toolName: 'list' }, 'list', true)).toBe(true);
    expect(covers({ scope: 'TOOL', toolName: 'list' }, 'add', true)).toBe(false);
  });

  it('READONLY covers read-only tools only', () => {
    expect(covers({ scope: 'READONLY', toolName: null }, 'list', true)).toBe(true);
    expect(covers({ scope: 'READONLY', toolName: null }, 'add', false)).toBe(false);
  });

  it('UPSTREAM covers every tool', () => {
    expect(covers({ scope: 'UPSTREAM', toolName: null }, 'delete_all', false)).toBe(true);
  });

  it('a TOOL row without a name covers nothing (fail closed)', () => {
    expect(covers({ scope: 'TOOL', toolName: null }, 'list', true)).toBe(false);
  });

  it('takes the latest covering row', () => {
    const rows = [
      { scope: 'TOOL' as const, toolName: 'add', until: d(30) },
      { scope: 'READONLY' as const, toolName: null, until: d(50) },
      { scope: 'UPSTREAM' as const, toolName: null, until: d(20) },
    ];
    expect(latestCovering(rows, 'add', false)).toEqual(d(30));
    expect(latestCovering(rows, 'list', true)).toEqual(d(50));
    expect(latestCovering(rows, 'other', false)).toEqual(d(20));
    expect(latestCovering([], 'x', true)).toBeNull();
  });

  it('reads read-only from stored annotations', () => {
    expect(isReadOnly('{"readOnlyHint":true}')).toBe(true);
    expect(isReadOnly('{"readOnlyHint":true,"destructiveHint":true}')).toBe(true);
    expect(isReadOnly('{"readOnlyHint":false}')).toBe(false);
    expect(isReadOnly(null)).toBe(false);
    expect(isReadOnly('not json')).toBe(false);
  });
});
