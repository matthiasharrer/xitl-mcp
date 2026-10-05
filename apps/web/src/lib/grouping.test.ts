// Grouping of Verlauf/Freigaben (TC-75 unit part). Local time is used for
// days, so the dates below are built with the local Date constructor.
import { describe, expect, it } from 'vitest';
import { dayLabel, groupByDay, groupCalls, GROUP_GAP_MS } from './grouping';

const at = (h: number, m: number, day = 5) => new Date(2026, 9, day, h, m).toISOString();
const call = (receivedAt: string, clientId: number | null = 1, session: string | null = null) => ({
  receivedAt,
  clientId,
  clientName: clientId === null ? null : `Client ${clientId}`,
  session: session ? { id: session, createdAt: receivedAt } : null,
});

describe('dayLabel', () => {
  const now = new Date(2026, 9, 5, 12, 0);
  it('names today and yesterday', () => {
    expect(dayLabel(new Date(2026, 9, 5, 0, 1), now)).toBe('Heute');
    expect(dayLabel(new Date(2026, 9, 4, 23, 59), now)).toBe('Gestern');
  });
  it('dates older days, with the year only when it differs', () => {
    expect(dayLabel(new Date(2026, 9, 2), now)).toMatch(/2\. Okt/);
    expect(dayLabel(new Date(2026, 9, 2), now)).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 11, 31), now)).toMatch(/2025/);
  });
  it('handles the month boundary for yesterday', () => {
    expect(dayLabel(new Date(2026, 8, 30, 20, 0), new Date(2026, 9, 1, 8, 0))).toBe('Gestern');
  });
});

describe('groupCalls', () => {
  it('keeps calls of one client within the gap together', () => {
    const groups = groupCalls([call(at(14, 20)), call(at(14, 12)), call(at(14, 3))]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(3);
    expect(groups[0]!.from.toISOString()).toBe(at(14, 3));
    expect(groups[0]!.to.toISOString()).toBe(at(14, 20));
  });

  it('splits on a gap longer than 10 minutes (measured between neighbours)', () => {
    expect(GROUP_GAP_MS).toBe(600_000);
    const groups = groupCalls([call(at(15, 0)), call(at(14, 49)), call(at(14, 40))]);
    expect(groups.map((g) => g.items.length)).toEqual([1, 2]);
  });

  it('separates interleaved clients, ordered by their newest call', () => {
    const groups = groupCalls([call(at(14, 9), 2), call(at(14, 8), 1), call(at(14, 5), 2), call(at(14, 1), 1)]);
    expect(groups.map((g) => [g.clientName, g.items.length])).toEqual([
      ['Client 2', 2],
      ['Client 1', 2],
    ]);
  });

  it('keeps a session together across long pauses, apart from sessionless calls', () => {
    const groups = groupCalls([call(at(16, 0), 1, 'S'), call(at(15, 30), 1), call(at(14, 0), 1, 'S')]);
    expect(groups.map((g) => [g.session?.id ?? null, g.items.length])).toEqual([
      ['S', 2],
      [null, 1],
    ]);
  });

  it('does not depend on the input order', () => {
    const groups = groupCalls([call(at(14, 1)), call(at(14, 40)), call(at(14, 5))]);
    expect(groups.map((g) => g.items.map((i) => i.receivedAt))).toEqual([[at(14, 40)], [at(14, 5), at(14, 1)]]);
  });

  it('groups revoked clients (no id) by name', () => {
    expect(groupCalls([call(at(14, 2), null), call(at(14, 1), null)])).toHaveLength(1);
  });
});

describe('groupByDay', () => {
  it('puts a separator between days and never spans one group over midnight', () => {
    const now = new Date(2026, 9, 5, 12, 0);
    const days = groupByDay([call(at(0, 3)), call(at(23, 58, 4)), call(at(9, 0, 3))], now);
    expect(days.map((d) => d.label)).toEqual(['Heute', 'Gestern', expect.stringMatching(/3\. Okt/)]);
    expect(days.map((d) => d.groups.length)).toEqual([1, 1, 1]);
  });
});
