// ADR-0022 (unit): withUpstream records a failed contact in lastFailureAt and
// leaves the connection states alone; bookkeeping never changes the outcome.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const findFirst = vi.fn();
const updateMany = vi.fn();
vi.mock('../db.js', () => ({ prisma: { upstream: { findFirst, updateMany } } }));
const { withUpstream, UpstreamNeedsReconnect, UpstreamNotConnected, storedState } = await import('./connection.js');

const NOW = new Date('2026-10-05T12:00:00Z');
const clock = { now: () => NOW } as never;
// Port 1 of a loopback address: refused by the outbound policy (ADR-0020).
const row = (over: Record<string, unknown> = {}) => ({
  id: 7, userId: 1, auth: 'NONE', status: 'CONNECTED', url: 'http://127.0.0.1:1/mcp',
  accessToken: null, refreshToken: null, headerName: null, headerValue: null,
  tokenExpiresAt: null, instructions: null, lastFailureAt: null, allowInternal: false, ...over,
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
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 7, userId: 1 }, data: { lastFailureAt: NOW } });
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
