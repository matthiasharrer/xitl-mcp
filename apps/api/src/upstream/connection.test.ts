// ADR-0022 (unit): withUpstream records a failed contact in lastFailureAt and
// leaves the connection states alone; bookkeeping never changes the outcome.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const findFirst = vi.fn();
const updateMany = vi.fn();
vi.mock('../db.js', () => ({ prisma: { upstream: { findFirst, updateMany } } }));
// ADR-0037: a spy that calls through, to prove a BUILTIN row never goes out.
const outboundSpy = vi.fn();
vi.mock('../lib/outbound.js', async (orig) => {
  const actual = await orig<typeof import('../lib/outbound.js')>();
  return {
    ...actual,
    outboundFetch: (...a: Parameters<typeof actual.outboundFetch>) => {
      outboundSpy(...a);
      return actual.outboundFetch(...a);
    },
  };
});
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
  outboundSpy.mockReset();
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

// ADR-0037 (TC-230): the BUILTIN kind is served in-process. No fetch, no
// outbound call, no credentials; fn gets a real client of the built-in server.
describe('BUILTIN upstream (ADR-0037)', () => {
  const builtin = (over: Record<string, unknown> = {}) => row({ auth: 'BUILTIN', url: 'builtin:xitl', ...over });

  test('never calls outboundFetch or global fetch; the client lists exactly the three read-only tools, with instructions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    findFirst.mockResolvedValue(builtin());
    try {
      const seen = await withUpstream(7, 1, async ({ client, secrets }) => ({
        tools: (await client.listTools()).tools,
        instructions: client.getInstructions(),
        secrets: secrets(),
      }), { clock, timeoutMs: 2000 });
      expect(seen.tools.map((t) => t.name)).toEqual(['list_upstreams', 'list_history', 'get_history_entry']);
      for (const t of seen.tools) expect(t.annotations?.readOnlyHint).toBe(true);
      expect(seen.instructions).toBeTruthy();
      expect(seen.secrets).toEqual([]);
      expect(outboundSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      // The instructions are stored like an HTTP upstream's (the unified initialize reads them back).
      expect(updateMany).toHaveBeenCalledWith({ where: { id: 7, userId: 1 }, data: { instructions: seen.instructions } });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('a paused BUILTIN row is refused first, like any other', async () => {
    findFirst.mockResolvedValue(builtin({ pausedAt: new Date('2026-10-05T11:00:00Z') }));
    await expect(run()).rejects.toBeInstanceOf(UpstreamPaused);
  });

  test('a failing fn records the failure like an HTTP upstream', async () => {
    findFirst.mockResolvedValue(builtin());
    await expect(withUpstream(7, 1, async () => { throw new Error('boom'); }, { clock, timeoutMs: 2000 })).rejects.toThrow('boom');
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 7, userId: 1, lastFailureAt: null }, data: { lastFailureAt: NOW } });
  });

  test('an unknown auth kind is refused before anything is contacted (fail closed)', async () => {
    findFirst.mockResolvedValue(row({ auth: 'SOMETHING_NEW' }));
    await expect(run()).rejects.toBeInstanceOf(UpstreamNotConnected);
    expect(outboundSpy).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  test('storedState / isUsable: a BUILTIN row is usable and ok, unreachable after a failure', () => {
    expect(storedState({ auth: 'BUILTIN', status: 'CONNECTED', accessToken: null, lastFailureAt: null })).toBe('ok');
    expect(storedState({ auth: 'BUILTIN', status: 'CONNECTED', accessToken: null, lastFailureAt: NOW })).toBe('unreachable');
  });
});
