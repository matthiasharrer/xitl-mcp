// ADR-0034 helpers: the window, the vanished rule and single-flight.
import { describe, expect, test } from 'vitest';
import { DEFAULT_TOOLS_FRESH_MS, SingleFlight, toolsFreshFromEnv, toolsStale, vanished } from './freshness.js';

describe('toolsFreshFromEnv', () => {
  test('default 5 minutes; positive integers only', () => {
    expect(DEFAULT_TOOLS_FRESH_MS).toBe(300_000);
    expect(toolsFreshFromEnv(undefined)).toBe(300_000);
    expect(toolsFreshFromEnv('2500')).toBe(2500);
    expect(toolsFreshFromEnv(' 2500 ')).toBe(2500);
    for (const bad of ['', '0', '-5', '1.5', 'abc', '1e6', '9999999999']) expect(toolsFreshFromEnv(bad)).toBe(300_000);
  });
});

describe('toolsStale', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const W = 300_000;
  test('fresh only strictly inside the window', () => {
    expect(toolsStale(new Date(now.getTime() - 1000), now, W)).toBe(false);
    expect(toolsStale(now, now, W)).toBe(false);
    expect(toolsStale(new Date(now.getTime() - W + 1), now, W)).toBe(false);
    expect(toolsStale(new Date(now.getTime() - W), now, W)).toBe(true);
    expect(toolsStale(new Date(now.getTime() - W - 1), now, W)).toBe(true);
  });
  test('never synced, garbage or future times: stale (re-list)', () => {
    expect(toolsStale(null, now, W)).toBe(true);
    expect(toolsStale(undefined, now, W)).toBe(true);
    expect(toolsStale(new Date(NaN), now, W)).toBe(true);
    expect(toolsStale('2026-10-07T12:00:00Z' as never, now, W)).toBe(true);
    expect(toolsStale(new Date(now.getTime() + 60_000), now, W)).toBe(true);
    expect(toolsStale(now, new Date(NaN), W)).toBe(true);
  });
});

describe('vanished', () => {
  const t = new Date('2026-10-07T12:00:00Z');
  test('seen before the last sync = vanished; same time = listed', () => {
    expect(vanished(new Date(t.getTime() - 1), t)).toBe(true);
    expect(vanished(t, t)).toBe(false);
    expect(vanished(t, null)).toBe(false);
  });
});

describe('SingleFlight', () => {
  test('concurrent runs share one call; settled entries are dropped', async () => {
    const sf = new SingleFlight<number, number>();
    let calls = 0;
    let release!: (v: number) => void;
    const fn = () => {
      calls++;
      return new Promise<number>((r) => (release = r));
    };
    const all = Promise.all([sf.run(1, fn), sf.run(1, fn), sf.run(1, fn)]);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(sf.size).toBe(1);
    release(7);
    expect(await all).toEqual([7, 7, 7]);
    expect(sf.size).toBe(0);
    await sf.run(1, async () => ++calls);
    expect(calls).toBe(2);
  });
  test('a failure reaches every waiter and the next run tries again', async () => {
    const sf = new SingleFlight<number, void>();
    let calls = 0;
    // Throws synchronously: must not leave a stuck entry.
    const failing = (): Promise<void> => {
      calls++;
      throw new Error('boom');
    };
    const rs = await Promise.allSettled([sf.run(1, failing), sf.run(1, failing)]);
    expect(rs.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
    await expect(sf.run(1, failing)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
  test('different keys run independently', async () => {
    const sf = new SingleFlight<number, number>();
    let calls = 0;
    await Promise.all([sf.run(1, async () => ++calls), sf.run(2, async () => ++calls)]);
    expect(calls).toBe(2);
  });
});
