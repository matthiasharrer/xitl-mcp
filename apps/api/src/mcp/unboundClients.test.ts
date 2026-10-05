// TC-88 (unit): which never-approved DCR clients are pruned. The DB half
// (kind/userId filter, the real delete) is covered by e2e TC-88.
import { describe, expect, test, vi } from 'vitest';

vi.mock('../db.js', () => ({ prisma: {} }));
const { unboundClientsToPrune } = await import('./unboundClients.js');
const { MAX_UNBOUND_CLIENTS, UNBOUND_CLIENT_TTL_MS } = await import('../lib/limits.js');

const now = new Date(Date.UTC(2026, 9, 5, 12, 0));
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(now.getTime() - ms);
const row = (id: number, ageMs: number) => ({ id, createdAt: ago(ageMs) });

describe('unboundClientsToPrune (TC-88)', () => {
  test('limits: 24 h, 100 clients', () => {
    expect(UNBOUND_CLIENT_TTL_MS).toBe(24 * HOUR);
    expect(MAX_UNBOUND_CLIENTS).toBe(100);
  });

  test('older than 24 h goes, younger stays, exactly 24 h stays', () => {
    const rows = [row(1, 25 * HOUR), row(2, HOUR), row(3, 24 * HOUR), row(4, 24 * HOUR + 1)];
    expect(unboundClientsToPrune(rows, now).sort()).toEqual([1, 4]);
  });

  test('over the cap the oldest go first (ties by id)', () => {
    const rows = [row(10, 3 * HOUR), row(11, 1 * HOUR), row(12, 5 * HOUR), row(13, 5 * HOUR), row(14, 2 * HOUR)];
    expect(unboundClientsToPrune(rows, now, { maxUnbound: 3 })).toEqual([12, 13]);
  });

  test('reserve leaves room for the client about to be created', () => {
    const rows = [row(1, 3 * HOUR), row(2, 2 * HOUR), row(3, HOUR)];
    expect(unboundClientsToPrune(rows, now, { maxUnbound: 3 })).toEqual([]);
    expect(unboundClientsToPrune(rows, now, { maxUnbound: 3, reserve: 1 })).toEqual([1]);
  });

  test('expired ones count first, then the cap applies to the rest', () => {
    const rows = [row(1, 30 * HOUR), row(2, 3 * HOUR), row(3, 2 * HOUR), row(4, HOUR)];
    expect(unboundClientsToPrune(rows, now, { maxUnbound: 2, reserve: 1 })).toEqual([1, 2, 3]);
  });

  test('a custom maxAgeMs is honoured; nothing to do is an empty list', () => {
    expect(unboundClientsToPrune([row(1, 2 * HOUR)], now, { maxAgeMs: HOUR })).toEqual([1]);
    expect(unboundClientsToPrune([], now, { reserve: 1 })).toEqual([]);
  });
});
