// TC-24: policy precedence. client override > tool policy > unacknowledged
// tool (= ASK) > upstream default, except that a changed tool never resolves
// to ALLOW ("changed-tool"); unknown tool = DENY; every result names its
// decision path; garbage fails closed.
import { describe, expect, test } from 'vitest';
import { awaitingReview, evaluatePolicy, type Policy } from './policy.js';

const ACK = new Date('2026-10-04T10:00:00Z');
const CHANGED = new Date('2026-10-04T11:00:00Z');
const known = (policy: Policy | null = null, acknowledgedAt: Date | null = ACK, changedAt: Date | null = null) => ({
  policy,
  acknowledgedAt,
  changedAt,
});
/** A rug-pulled tool: acknowledgement withdrawn, changedAt set (tools.ts). */
const changed = (policy: Policy | null = null) => known(policy, null, CHANGED);

describe('evaluatePolicy (TC-24)', () => {
  test('unknown tool is DENY, whatever else is configured', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: null, clientOverride: 'ALLOW' })).toEqual({
        policy: 'DENY',
        path: 'unknown-tool',
      });
    }
  });

  test('acknowledged tool without own policy follows the upstream default', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: known(), clientOverride: null })).toEqual({
        policy: d,
        path: 'policy:upstream-default',
      });
    }
  });

  test('a new (unacknowledged) tool is ASK even under default ALLOW and DENY', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: known(null, null), clientOverride: null })).toEqual({
        policy: 'ASK',
        path: 'new-tool',
      });
    }
  });

  test('tool policy beats the new-tool rule and the default', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known('ALLOW', null), clientOverride: null })).toEqual({
      policy: 'ALLOW',
      path: 'policy:tool',
    });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('DENY'), clientOverride: null })).toEqual({
      policy: 'DENY',
      path: 'policy:tool',
    });
  });

  test('client override beats tool policy, new-tool and default (both directions)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ALLOW'), clientOverride: 'DENY' })).toEqual({
      policy: 'DENY',
      path: 'policy:client',
    });
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known('DENY', null), clientOverride: 'ALLOW' })).toEqual({
      policy: 'ALLOW',
      path: 'policy:client',
    });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: 'ASK' })).toEqual({
      policy: 'ASK',
      path: 'policy:client',
    });
  });

  test('changed tool: an explicit ALLOW (tool or client) becomes ASK "changed-tool" (TC-36)', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed('ALLOW'), clientOverride: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed(), clientOverride: 'ALLOW' })).toEqual({ policy: 'ASK', path: 'changed-tool' });
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed('DENY'), clientOverride: 'ALLOW' })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    }
  });

  test('changed tool: explicit ASK / DENY apply unchanged, with their own path', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('DENY'), clientOverride: null })).toEqual({ policy: 'DENY', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ASK'), clientOverride: null })).toEqual({ policy: 'ASK', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: 'DENY' })).toEqual({ policy: 'DENY', path: 'policy:client' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: 'ASK' })).toEqual({ policy: 'ASK', path: 'policy:client' });
  });

  test('changed tool without own rule is ASK "changed-tool" under any default', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed(), clientOverride: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    }
  });

  test('changedAt still set counts as changed even with acknowledgedAt (fail closed)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ALLOW', ACK, CHANGED), clientOverride: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    expect(awaitingReview(known(null, ACK, CHANGED))).toBe(true);
  });

  test('acknowledging (changedAt cleared, acknowledgedAt set) restores the explicit rule', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known('ALLOW'), clientOverride: null })).toEqual({ policy: 'ALLOW', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known(), clientOverride: 'ALLOW' })).toEqual({ policy: 'ALLOW', path: 'policy:client' });
  });

  test('a new (never changed) tool keeps explicit ALLOW (only changes withdraw it)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known(null, null), clientOverride: 'ALLOW' })).toEqual({ policy: 'ALLOW', path: 'policy:client' });
  });

  test('garbage policy values fail closed to DENY', () => {
    const bad = 'always_allow' as unknown as Policy;
    expect(evaluatePolicy({ upstreamDefault: bad, tool: known(), clientOverride: null }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(bad), clientOverride: null }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: bad }).policy).toBe('DENY');
  });
});

// TC-30 (unit): a live snooze only upgrades ASK to ALLOW ("snooze"); never
// DENY, never an unknown tool, never a new/changed tool; expired = no effect.
describe('evaluatePolicy snooze (TC-30)', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const live = new Date('2026-10-04T13:00:00Z');
  const past = new Date('2026-10-04T11:59:59Z');

  test('ASK from default, tool policy or client override becomes ALLOW via snooze', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'snooze' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ASK'), clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'snooze' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: 'ASK', snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'snooze' });
  });

  test('never upgrades DENY (any source)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known(), clientOverride: null, snoozedUntil: live, now }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('DENY'), clientOverride: null, snoozedUntil: live, now }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: 'DENY', snoozedUntil: live, now }).policy).toBe('DENY');
  });

  test('never upgrades an unknown tool or a new/changed (unacknowledged) tool', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: null, clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'DENY', path: 'unknown-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'new-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed(), clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed(), clientOverride: 'ALLOW', snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'changed-tool' });
  });

  test('never upgrades an explicit ASK on a tool awaiting review (new or changed)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ASK'), clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: 'ASK', snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'policy:client' });
    expect(awaitingReview(changed('ASK'))).toBe(true);
    expect(awaitingReview(known(null, null))).toBe(true);
    expect(awaitingReview(known())).toBe(false);
  });

  test('expired, exactly-now, missing clock or invalid date: no effect', () => {
    const ask = { upstreamDefault: 'ASK' as const, tool: known(), clientOverride: null };
    expect(evaluatePolicy({ ...ask, snoozedUntil: past, now }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: now, now }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: live }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: new Date('nope'), now }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: null, now }).path).toBe('policy:upstream-default');
  });

  test('ALLOW stays ALLOW with its own path (snooze does not rewrite it)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: null, snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'policy:upstream-default' });
  });
});
