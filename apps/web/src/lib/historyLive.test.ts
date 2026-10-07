import { describe, expect, it } from 'vitest';
import { applyLiveRow, mergeFirstPage } from './historyLive';
import { groupByDay } from './grouping';
import type { AuditRow } from './api';

const row = (id: number, extra: Partial<AuditRow> = {}): AuditRow =>
  ({
    id,
    tool: `t${id}`,
    upstream: null,
    clientName: 'C',
    clientId: 1,
    outcome: 'PENDING',
    decisionPath: 'x',
    isError: null,
    receivedAt: new Date(2026, 9, 7, 12, 0, id).toISOString(),
    session: null,
    ...extra,
  }) as AuditRow;
const ids = (l: AuditRow[]) => l.map((e) => e.id);

describe('applyLiveRow', () => {
  it('puts a new newest row on top', () => {
    expect(ids(applyLiveRow([row(5), row(4)], 3, row(6)))).toEqual([6, 5, 4]);
  });
  it('replaces a known row in place', () => {
    const out = applyLiveRow([row(5), row(4)], 3, row(5, { outcome: 'FORWARDED' }));
    expect(ids(out)).toEqual([5, 4]);
    expect(out[0]!.outcome).toBe('FORWARDED');
  });
  it('ignores an unknown row older than the loaded window while more pages exist', () => {
    const list = [row(5), row(4)];
    expect(applyLiveRow(list, 3, row(2))).toBe(list);
  });
  it('inserts an older unknown row when everything is loaded', () => {
    expect(ids(applyLiveRow([row(5), row(4)], null, row(2)))).toEqual([5, 4, 2]);
  });
  it('fills an empty list when nothing more exists; ignores it when pages exist', () => {
    expect(ids(applyLiveRow([], null, row(1)))).toEqual([1]);
    expect(applyLiveRow([], 7, row(1))).toEqual([]);
  });
  it('keeps a row landing between loaded rows ordered by id', () => {
    expect(ids(applyLiveRow([row(9), row(5)], 4, row(7)))).toEqual([9, 7, 5]);
  });
  it('stays consistent with grouping: a new call of the same client joins the group', () => {
    const now = new Date(2026, 9, 7, 13, 0, 0);
    const before = groupByDay([row(2), row(1)], now);
    const after = groupByDay(applyLiveRow([row(2), row(1)], null, row(3)), now);
    expect(before[0]!.groups).toHaveLength(1);
    expect(after[0]!.groups).toHaveLength(1);
    expect(after[0]!.groups[0]!.items.map((e) => e.id)).toEqual([3, 2, 1]);
  });
});

describe('mergeFirstPage', () => {
  it('a complete first page replaces the list', () => {
    expect(ids(mergeFirstPage([row(3), row(2)], [row(4), row(3), row(2), row(1)], null))).toEqual([4, 3, 2, 1]);
  });
  it('keeps older loaded pages below the fresh first page, fresh data wins', () => {
    const loaded = [row(10), row(9), row(8), row(7), row(6)];
    const page = [row(11), row(10, { outcome: 'DENIED' }), row(9)];
    const out = mergeFirstPage(loaded, page, 8);
    expect(ids(out)).toEqual([11, 10, 9, 8, 7, 6]);
    expect(out[1]!.outcome).toBe('DENIED');
  });
  it('drops loaded rows the fresh page no longer contains inside its range', () => {
    const out = mergeFirstPage([row(10), row(9), row(8)], [row(10), row(8)], 5);
    expect(ids(out)).toEqual([10, 8]);
  });
});
