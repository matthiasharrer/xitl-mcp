// ADR-0037 / TC-235 (unit): the strict argument parser and the filter -> where
// mapping of list_history. Pure; no database.
import { describe, expect, test } from 'vitest';
import { berlinIso, historyWhere, parseHistoryArgs, pauseCheckResult, type HistoryFilter } from './history.js';

const ok = (args: unknown) => {
  const r = parseHistoryArgs(args);
  if (!r.ok) throw new Error(r.message);
  return r.filter;
};

describe('parseHistoryArgs', () => {
  test('no arguments: default limit 20, no filters', () => {
    expect(ok({})).toEqual({ limit: 20 });
    expect(ok(undefined)).toEqual({ limit: 20 });
  });

  test('every filter parses', () => {
    const f = ok({ upstream: 'haushalt', tool: 'add_task', status: 'timed_out', pause_check: 'mismatch', from: '2026-10-01', to: '2026-10-25T12:00:00+02:00', limit: 50, before: 99 });
    expect(f).toMatchObject({ upstream: 'haushalt', tool: 'add_task', status: 'timed_out', pauseCheck: 'mismatch', limit: 50, before: 99 });
    expect(f.from).toEqual({ kind: 'day', ymd: '2026-10-01' });
    expect(f.to).toMatchObject({ kind: 'instant' });
  });

  test.each([
    [{ limit: 0 }],
    [{ limit: 51 }],
    [{ limit: -1 }],
    [{ limit: 'x' }],
    [{ limit: '5' }],
    [{ limit: 1.5 }],
    [{ limit: null }],
    [{ before: 0 }],
    [{ before: 'x' }],
    [{ before: -3 }],
    [{ status: 'done' }],
    [{ status: 'FORWARDED' }],
    [{ status: 3 }],
    [{ pause_check: 'all' }],
    [{ pause_check: 'gleich' }],
    [{ upstream: 'Not A Slug' }],
    [{ upstream: '' }],
    [{ upstream: 7 }],
    [{ tool: '' }],
    [{ tool: 7 }],
    [{ from: 'gestern' }],
    [{ from: '2026-02-30' }],
    [{ from: '2026-10-25T10:00:00' }], // no offset: ambiguous, refused
    [{ to: '25.10.2026' }],
    [{ to: 20261025 }],
    [{ unknown_filter: 'x' }],
    [{ pauseCheck: 'match' }], // wrong spelling: refused, never silently ignored
    ['x'],
    [[]],
  ])('invalid %j is an error with a German and an English text, never a filter', (args) => {
    const r = parseHistoryArgs(args);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain(' / ');
      expect(r.message.length).toBeLessThan(400);
    }
  });
});

describe('historyWhere', () => {
  const f = (over: Partial<HistoryFilter> = {}): HistoryFilter => ({ limit: 20, ...over });
  const and = (where: ReturnType<typeof historyWhere>) => where.AND as Record<string, unknown>[];

  test('always scoped to the user, with or without filters (TC-232)', () => {
    expect(historyWhere(7, f()).userId).toBe(7);
    expect(historyWhere(7, f({ upstream: 'a', tool: 't', status: 'denied' })).userId).toBe(7);
  });

  test('the upstream filter is scoped to the same user too', () => {
    expect(and(historyWhere(7, f({ upstream: 'haushalt' })))).toEqual([{ upstream: { is: { slug: 'haushalt', userId: 7 } } }]);
  });

  test('status, tool and pause_check map to columns', () => {
    expect(and(historyWhere(1, f({ status: 'timed_out' })))).toEqual([{ outcome: 'TIMED_OUT' }]);
    expect(and(historyWhere(1, f({ tool: 'x' })))).toEqual([{ toolName: 'x' }]);
    expect(and(historyWhere(1, f({ pauseCheck: 'match' })))).toEqual([{ pauseCheckChoice: 'gleich' }]);
    expect(and(historyWhere(1, f({ pauseCheck: 'mismatch' })))).toEqual([{ pauseCheckChoice: { in: ['richtungswechsel', 'ausweitung'] } }]);
    expect(and(historyWhere(1, f({ pauseCheck: 'error' })))).toEqual([{ decisionPath: { startsWith: 'snooze-ki-error' } }]);
  });

  test('a day filter covers the whole Berlin day, both ends inclusive (DST change day included)', () => {
    const w = and(historyWhere(1, f({ from: { kind: 'day', ymd: '2026-10-25' }, to: { kind: 'day', ymd: '2026-10-25' } })));
    expect(w).toEqual([{ receivedAt: { gte: new Date('2026-10-24T22:00:00Z') } }, { receivedAt: { lt: new Date('2026-10-25T23:00:00Z') } }]);
  });

  test('an instant bound is taken as is, "to" inclusive', () => {
    const at = new Date('2026-10-25T10:00:00Z');
    expect(and(historyWhere(1, f({ from: { kind: 'instant', at }, to: { kind: 'instant', at } })))).toEqual([{ receivedAt: { gte: at } }, { receivedAt: { lte: at } }]);
  });

  test('before pages by id', () => {
    expect(and(historyWhere(1, f({ before: 40 })))).toEqual([{ id: { lt: 40 } }]);
  });
});

describe('helpers', () => {
  test('berlinIso gives Berlin local time with its offset', () => {
    expect(berlinIso(new Date('2026-07-01T10:00:05Z'))).toBe('2026-07-01T12:00:05+02:00');
    expect(berlinIso(new Date('2026-01-15T10:00:05Z'))).toBe('2026-01-15T11:00:05+01:00');
    expect(berlinIso(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25T02:30:00+02:00');
    expect(berlinIso(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25T02:30:00+01:00');
  });

  test('pauseCheckResult', () => {
    expect(pauseCheckResult({ decisionPath: 'snooze+ki', pauseCheckChoice: 'gleich' })).toBe('match');
    expect(pauseCheckResult({ decisionPath: 'snooze-ki-mismatch', pauseCheckChoice: 'ausweitung' })).toBe('mismatch');
    expect(pauseCheckResult({ decisionPath: 'snooze-ki-error+timeout', pauseCheckChoice: null })).toBe('error');
    expect(pauseCheckResult({ decisionPath: 'snooze', pauseCheckChoice: null })).toBeNull();
    expect(pauseCheckResult({ decisionPath: 'policy:tool', pauseCheckChoice: 'komisch' })).toBeNull();
  });
});
