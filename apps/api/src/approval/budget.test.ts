// TC-37 (budget), TC-30 (snooze end times), TC-32 (summary): pure helpers.
import { describe, expect, test } from 'vitest';
import {
  approvalDeadline,
  approvalSummary,
  approvalTimeoutFromEnv,
  berlinDayStart,
  nextBerlinDay,
  CALL_BUDGET_MS,
  MIN_UPSTREAM_MS,
  nextBerlinMidnight,
  snoozeUntil,
  SUMMARY_MAX,
  upstreamTimeoutMs,
} from './budget.js';

const t0 = new Date('2026-10-04T12:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

describe('approval budget (TC-37)', () => {
  test('the approval wait never eats the floor reserved for the upstream call', () => {
    expect(approvalDeadline(t0, 300_000)).toEqual(at(CALL_BUDGET_MS - MIN_UPSTREAM_MS));
    expect(approvalDeadline(t0, 3_000)).toEqual(at(3_000));
    expect(approvalDeadline(t0, 10 * 60_000)).toEqual(at(CALL_BUDGET_MS - MIN_UPSTREAM_MS));
  });

  test('an approved call gets what is left of 300 s from receipt, capped by the per-call timeout', () => {
    expect(upstreamTimeoutMs(t0, at(1_000), 120_000)).toBe(120_000);
    expect(upstreamTimeoutMs(t0, at(250_000), 120_000)).toBe(50_000);
    expect(upstreamTimeoutMs(t0, at(CALL_BUDGET_MS - MIN_UPSTREAM_MS), 120_000)).toBe(MIN_UPSTREAM_MS);
  });

  test('less than the floor left (or past the budget): not forwarded', () => {
    expect(upstreamTimeoutMs(t0, at(CALL_BUDGET_MS - MIN_UPSTREAM_MS + 1), 120_000)).toBeNull();
    expect(upstreamTimeoutMs(t0, at(CALL_BUDGET_MS + 10_000), 120_000)).toBeNull();
  });

  test('wait + upstream timeout never exceed the budget, whenever the approval comes', () => {
    for (let decided = 0; decided <= CALL_BUDGET_MS; decided += 7_919) {
      const timeout = upstreamTimeoutMs(t0, at(decided), 120_000);
      if (timeout !== null) expect(decided + timeout).toBeLessThanOrEqual(CALL_BUDGET_MS);
    }
  });

  test('APPROVAL_TIMEOUT_MS env: positive integers only, else 300 s', () => {
    expect(approvalTimeoutFromEnv('3000')).toBe(3000);
    expect(approvalTimeoutFromEnv(undefined)).toBe(300_000);
    expect(approvalTimeoutFromEnv('0')).toBe(300_000);
    expect(approvalTimeoutFromEnv('-5')).toBe(300_000);
    expect(approvalTimeoutFromEnv('1e3')).toBe(300_000);
  });
});

describe('snooze end (TC-30)', () => {
  test('minutes, capped to 24 h; nothing for "Einmal erlauben"', () => {
    expect(snoozeUntil(t0, { snoozeMinutes: 15 })).toEqual(at(15 * 60_000));
    expect(snoozeUntil(t0, { snoozeMinutes: 60 })).toEqual(at(3_600_000));
    expect(snoozeUntil(t0, {})).toBeNull();
    expect(snoozeUntil(t0, { snoozeMinutes: 0 })).toBeNull();
    expect(snoozeUntil(t0, { snoozeMinutes: 24 * 60 + 1 })).toBeNull();
    expect(snoozeUntil(t0, { snoozeMinutes: 1.5 })).toBeNull();
  });

  test('"Heute" ends at the next midnight in Europe/Berlin (summer, winter, DST days)', () => {
    // CEST (UTC+2): 2026-10-04 14:00 local -> 2026-10-05 00:00 local = 22:00Z
    expect(nextBerlinMidnight(new Date('2026-10-04T12:00:00Z')).toISOString()).toBe('2026-10-04T22:00:00.000Z');
    // just after local midnight -> the NEXT midnight, not this one
    expect(nextBerlinMidnight(new Date('2026-10-04T22:00:01Z')).toISOString()).toBe('2026-10-05T22:00:00.000Z');
    // CET (UTC+1)
    expect(nextBerlinMidnight(new Date('2026-12-24T18:00:00Z')).toISOString()).toBe('2026-12-24T23:00:00.000Z');
    // day the clocks go back (2026-10-25): midnight after is CET
    expect(nextBerlinMidnight(new Date('2026-10-25T10:00:00Z')).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    // day the clocks go forward (2027-03-28): midnight after is CEST
    expect(nextBerlinMidnight(new Date('2027-03-28T10:00:00Z')).toISOString()).toBe('2027-03-28T22:00:00.000Z');
    // 23:30 local in winter
    expect(nextBerlinMidnight(new Date('2026-12-24T22:30:00Z')).toISOString()).toBe('2026-12-24T23:00:00.000Z');
  });
});

describe('push summary (TC-32)', () => {
  test('tool and first argument values, one line, truncated', () => {
    expect(approvalSummary('add_item', { item: 'Eier' })).toBe('add_item: Eier');
    expect(approvalSummary('x', { a: 'eins\nzwei', b: 3, c: true, d: ['a', 'b'], e: { k: 1 } })).toBe('x: eins zwei, 3, true, [2], {…}');
    expect(approvalSummary('list_items', {})).toBe('list_items (ohne Argumente)');
    const long = approvalSummary('add_item', { item: 'x'.repeat(5000), more: 'y' });
    expect(long.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ADR-0037 / TC-235: a Berlin calendar day as a time range, DST-correct.
describe('berlinDayStart / nextBerlinDay', () => {
  test('normal summer and winter days start at Berlin midnight', () => {
    expect(berlinDayStart('2026-07-01')!.toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(berlinDayStart('2026-01-15')!.toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });
  test('the day of the switch to winter time (2026-10-25) is 25 hours long', () => {
    const start = berlinDayStart('2026-10-25')!;
    const end = berlinDayStart(nextBerlinDay('2026-10-25')!)!;
    expect(start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
  test('the day of the switch to summer time (2026-03-29) is 23 hours long', () => {
    const start = berlinDayStart('2026-03-29')!;
    const end = berlinDayStart(nextBerlinDay('2026-03-29')!)!;
    expect(start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });
  test('month and year ends roll over; invalid dates are null', () => {
    expect(nextBerlinDay('2026-12-31')).toBe('2027-01-01');
    expect(nextBerlinDay('2026-02-28')).toBe('2026-03-01');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '', 'x', '2026-10-25T00:00', '20261025']) {
      expect(berlinDayStart(bad), bad).toBeNull();
      expect(nextBerlinDay(bad), bad).toBeNull();
    }
  });
});
