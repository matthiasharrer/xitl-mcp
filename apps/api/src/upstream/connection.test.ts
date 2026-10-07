// ADR-0022 (unit): withUpstream records a failed contact in lastFailureAt and
// leaves the connection states alone; bookkeeping never changes the outcome.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const findFirst = vi.fn();
const updateMany = vi.fn();
vi.mock('../db.js', () => ({ prisma: { upstream: { findFirst, updateMany } } }));
const { withUpstream, UpstreamNeedsReconnect, UpstreamNotConnected, UpstreamPaused, storedState, recordFailure, recordSuccess } = await import('./connection.js');
const { upstreamStates } = await import('./stateEvents.js');

const NOW = new Date('2026-10-05T12:00:00Z');
const clock = { now: () => NOW } as never;
// Port 1 of a loopback address: refused by the outbound policy (ADR-0020).
const row = (over: Record<string, unknown> = {}) => ({
  id: 7, userId: 1, auth: 'NONE', status: 'CONNECTED', url: 'http://127.0.0.1:1/mcp',
  accessToken: null, refreshToken: null, headerName: null, headerValue: null,
  tokenExpiresAt: null, instructions: null, lastFailureAt: null, allowInternal: false, pausedAt: null, ...over,
});
const run = () => withUpstream(7, 1, async () => 'ok', { clock, timeoutMs: 2000 });

beforeEach(() => {
  findFirst.mockReset();
  updateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe('withUpstream failure bookkeeping (TC-90)', () => {
  test('a failed contact sets lastFailureAt (Clock, scoped) and rethrows the original error', async () => {
    findFirst.mockResolvedValue(row());
    const err = await run().catch((e) => e);
    expect(err).not.toBeInstanceOf(UpstreamNeedsReconnect);
    // Conditional: only a healthy row is set (keeps "since", one transition).
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 7, userId: 1, lastFailureAt: null }, data: { lastFailureAt: NOW } });
  });

  test('a failing bookkeeping write does not mask the error', async () => {
    findFirst.mockResolvedValue(row());
    updateMany.mockRejectedValue(new Error('db locked'));
    const err = await run().catch((e) => e);
    expect(String(err.message)).not.toContain('db locked');
  });

  test('never connected / needs reconnect: thrown, nothing written', async () => {
    findFirst.mockResolvedValue(row({ auth: 'OAUTH', status: 'NOT_CONNECTED' }));
    await expect(run()).rejects.toBeInstanceOf(UpstreamNotConnected);
    findFirst.mockResolvedValue(row({ auth: 'OAUTH', status: 'NEEDS_RECONNECT', accessToken: 'x' }));
    await expect(run()).rejects.toBeInstanceOf(UpstreamNeedsReconnect);
    findFirst.mockResolvedValue(null);
    await expect(run()).rejects.toBeInstanceOf(UpstreamNotConnected);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

// ADR-0033 (TC-196 unit part): a paused row is refused before anything is
// contacted or refreshed; not a failure (nothing written, no transition).
describe('paused upstream (ADR-0033)', () => {
  test('UpstreamPaused before any contact, token refresh or bookkeeping', async () => {
    let contacted = false;
    const fn = async () => {
      contacted = true;
      return 'ok';
    };
    const paused = new Date('2026-10-05T11:00:00Z');
    const rows = [
      row({ pausedAt: paused }),
      // an expired OAuth token would be refreshed first: not while paused
      row({ pausedAt: paused, auth: 'OAUTH', status: 'CONNECTED', accessToken: 'x', tokenExpiresAt: new Date('2000-01-01') }),
      // a row without the field (anything but null) counts as paused
      { ...row(), pausedAt: undefined },
    ];
    for (const r of rows) {
      findFirst.mockResolvedValue(r);
      await expect(withUpstream(7, 1, fn, { clock, timeoutMs: 2000 })).rejects.toBeInstanceOf(UpstreamPaused);
    }
    expect(contacted).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('transitions (TC-94)', () => {
  const events: unknown[] = [];
  let off: () => void;
  beforeEach(() => {
    events.length = 0;
    off = upstreamStates.on((e) => events.push(e));
  });
  afterEach(() => off());

  test('first failure: count 1 -> one unreachable transition; already failing: count 0 -> none', async () => {
    expect(await recordFailure(7, 1, NOW)).toBe(true);
    expect(events).toEqual([{ userId: 1, upstreamId: 7, state: 'unreachable', cause: 'transition' }]);
    updateMany.mockResolvedValue({ count: 0 });
    expect(await recordFailure(7, 1, NOW)).toBe(false);
    expect(events).toHaveLength(1);
  });

  test('clearing: conditional on a set lastFailureAt; count 1 -> ok transition', async () => {
    expect(await recordSuccess(7, 1)).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 7, userId: 1, lastFailureAt: { not: null } }, data: { lastFailureAt: null } });
    expect(events).toEqual([{ userId: 1, upstreamId: 7, state: 'ok', cause: 'transition' }]);
    updateMany.mockResolvedValue({ count: 0 });
    expect(await recordSuccess(7, 1)).toBe(false);
    expect(events).toHaveLength(1);
  });

  test('a failing write or a throwing listener never reaches the caller', async () => {
    const offBad = upstreamStates.on(() => {
      throw new Error('listener');
    });
    try {
      await expect(recordFailure(7, 1, NOW)).resolves.toBe(true);
      updateMany.mockRejectedValue(new Error('db locked'));
      await expect(recordFailure(7, 1, NOW)).resolves.toBe(false);
      await expect(recordSuccess(7, 1)).resolves.toBe(false);
    } finally {
      offBad();
    }
  });

  test('withUpstream: a failure of a row that already failed keeps its timestamp, no transition', async () => {
    findFirst.mockResolvedValue(row({ lastFailureAt: new Date('2026-10-05T11:00:00Z') }));
    updateMany.mockResolvedValue({ count: 0 });
    await run().catch(() => undefined);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]![0].where).toEqual({ id: 7, userId: 1, lastFailureAt: null });
    expect(events).toHaveLength(0);
  });
});

describe('storedState', () => {
  test('reconnect, not-connected, unreachable, ok', () => {
    const base = { auth: 'OAUTH', accessToken: 'x', lastFailureAt: null } as const;
    expect(storedState({ ...base, status: 'NEEDS_RECONNECT' })).toBe('reconnect');
    expect(storedState({ ...base, status: 'NOT_CONNECTED', accessToken: null })).toBe('not-connected');
    expect(storedState({ ...base, status: 'CONNECTED', lastFailureAt: NOW })).toBe('unreachable');
    expect(storedState({ ...base, status: 'CONNECTED' })).toBe('ok');
    expect(storedState({ auth: 'NONE', status: 'NOT_CONNECTED', accessToken: null, lastFailureAt: null })).toBe('ok');
  });
});
