// TC-108 (unit): shown risk = max(tool hint, model risk); warning when lowered.
import { describe, expect, test } from 'vitest';
import { floorRisk, hintOfStored } from './risk.js';

describe('risk floor (TC-108)', () => {
  test('model read + destructive tool -> destructive, lowered', () => {
    expect(floorRisk(hintOfStored(JSON.stringify({ destructiveHint: true })), 'read')).toEqual({ risk: 'destructive', lowered: true });
  });
  test('model read + no annotations -> write, lowered', () => {
    expect(hintOfStored(null)).toBe('write');
    expect(hintOfStored('not json')).toBe('write');
    expect(floorRisk(hintOfStored(null), 'read')).toEqual({ risk: 'write', lowered: true });
  });
  test('model destructive + readOnly tool -> destructive, no warning', () => {
    expect(floorRisk(hintOfStored(JSON.stringify({ readOnlyHint: true })), 'destructive')).toEqual({ risk: 'destructive', lowered: false });
  });
  test('equal -> no warning', () => {
    expect(floorRisk('write', 'write')).toEqual({ risk: 'write', lowered: false });
    expect(floorRisk('read', 'read')).toEqual({ risk: 'read', lowered: false });
    expect(floorRisk('destructive', 'destructive')).toEqual({ risk: 'destructive', lowered: false });
  });
  test('model write + read-only tool -> write (raised), no warning', () => {
    expect(floorRisk('read', 'write')).toEqual({ risk: 'write', lowered: false });
  });
});
