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
      expect(evaluatePolicy({ upstreamDefault: d, tool: null, clientOverride: 'ALLOW', clientUpstream: null })).toEqual({
        policy: 'DENY',
        path: 'unknown-tool',
      });
    }
  });

  test('acknowledged tool without own policy follows the upstream default', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: known(), clientOverride: null, clientUpstream: null })).toEqual({
        policy: d,
        path: 'policy:upstream-default',
      });
    }
  });

  test('a new (unacknowledged) tool is ASK even under default ALLOW and DENY', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: known(null, null), clientOverride: null, clientUpstream: null })).toEqual({
        policy: 'ASK',
        path: 'new-tool',
      });
    }
  });

  test('tool policy beats the new-tool rule and the default', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known('ALLOW', null), clientOverride: null, clientUpstream: null })).toEqual({
      policy: 'ALLOW',
      path: 'policy:tool',
    });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('DENY'), clientOverride: null, clientUpstream: null })).toEqual({
      policy: 'DENY',
      path: 'policy:tool',
    });
  });

  test('client override beats tool policy, new-tool and default (both directions)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ALLOW'), clientOverride: 'DENY', clientUpstream: null })).toEqual({
      policy: 'DENY',
      path: 'policy:client',
    });
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known('DENY', null), clientOverride: 'ALLOW', clientUpstream: null })).toEqual({
      policy: 'ALLOW',
      path: 'policy:client',
    });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: 'ASK', clientUpstream: null })).toEqual({
      policy: 'ASK',
      path: 'policy:client',
    });
  });

  test('changed tool: an explicit ALLOW (tool or client) becomes ASK "changed-tool" (TC-36)', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed('ALLOW'), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed(), clientOverride: 'ALLOW', clientUpstream: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed('DENY'), clientOverride: 'ALLOW', clientUpstream: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    }
  });

  test('changed tool: explicit ASK / DENY apply unchanged, with their own path', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('DENY'), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'DENY', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ASK'), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'ASK', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: 'DENY', clientUpstream: null })).toEqual({ policy: 'DENY', path: 'policy:client' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: 'ASK', clientUpstream: null })).toEqual({ policy: 'ASK', path: 'policy:client' });
  });

  test('changed tool without own rule is ASK "changed-tool" under any default', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: changed(), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    }
  });

  test('changedAt still set counts as changed even with acknowledgedAt (fail closed)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ALLOW', ACK, CHANGED), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    expect(awaitingReview(known(null, ACK, CHANGED))).toBe(true);
  });

  test('acknowledging (changedAt cleared, acknowledgedAt set) restores the explicit rule', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known('ALLOW'), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'ALLOW', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known(), clientOverride: 'ALLOW', clientUpstream: null })).toEqual({ policy: 'ALLOW', path: 'policy:client' });
  });

  test('a new (never changed) tool keeps explicit ALLOW (only changes withdraw it)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known(null, null), clientOverride: 'ALLOW', clientUpstream: null })).toEqual({ policy: 'ALLOW', path: 'policy:client' });
  });

  test('garbage policy values fail closed to DENY', () => {
    const bad = 'always_allow' as unknown as Policy;
    expect(evaluatePolicy({ upstreamDefault: bad, tool: known(), clientOverride: null, clientUpstream: null }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(bad), clientOverride: null, clientUpstream: null }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: bad, clientUpstream: null }).policy).toBe('DENY');
  });
});

// TC-30 (unit): a live snooze only upgrades ASK to ALLOW ("snooze"); never
// DENY, never an unknown tool, never a new/changed tool; expired = no effect.
describe('evaluatePolicy snooze (TC-30)', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const live = new Date('2026-10-04T13:00:00Z');
  const past = new Date('2026-10-04T11:59:59Z');

  test('ASK from default, tool policy or client override becomes ALLOW via snooze', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'snooze' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ASK'), clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'snooze' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: 'ASK', clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'snooze' });
  });

  test('never upgrades DENY (any source)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known(), clientOverride: null, clientUpstream: null, snoozedUntil: live, now }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('DENY'), clientOverride: null, clientUpstream: null, snoozedUntil: live, now }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: 'DENY', clientUpstream: null, snoozedUntil: live, now }).policy).toBe('DENY');
  });

  test('never upgrades an unknown tool or a new/changed (unacknowledged) tool', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: null, clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'DENY', path: 'unknown-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'new-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed(), clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'changed-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed(), clientOverride: 'ALLOW', clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'changed-tool' });
  });

  test('never upgrades an explicit ASK on a tool awaiting review (new or changed)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ASK'), clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: 'ASK', clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ASK', path: 'policy:client' });
    expect(awaitingReview(changed('ASK'))).toBe(true);
    expect(awaitingReview(known(null, null))).toBe(true);
    expect(awaitingReview(known())).toBe(false);
  });

  test('expired, exactly-now, missing clock or invalid date: no effect', () => {
    const ask = { upstreamDefault: 'ASK' as const, tool: known(), clientOverride: null, clientUpstream: null };
    expect(evaluatePolicy({ ...ask, snoozedUntil: past, now }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: now, now }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: live }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: new Date('nope'), now }).path).toBe('policy:upstream-default');
    expect(evaluatePolicy({ ...ask, snoozedUntil: null, now }).path).toBe('policy:upstream-default');
  });

  test('ALLOW stays ALLOW with its own path (snooze does not rewrite it)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: null, clientUpstream: null, snoozedUntil: live, now })).toEqual({ policy: 'ALLOW', path: 'policy:upstream-default' });
  });
});

// TC-121 (precedence half): a live deny pause (ADR-0026) beats everything but
// unknown-tool; expired has no effect; anything not provably expired denies.
describe('deny pause (TC-121)', () => {
  const NOW = new Date('2026-10-06T12:00:00Z');
  const LIVE = new Date('2026-10-06T12:15:00Z');
  const DENIED = { policy: 'DENY', path: 'snooze-deny' };

  test('beats upstream default ALLOW/ASK/DENY', () => {
    for (const d of ['ALLOW', 'ASK', 'DENY'] as const) {
      expect(evaluatePolicy({ upstreamDefault: d, tool: known(), clientOverride: null, clientUpstream: null, denyPausedUntil: LIVE, now: NOW })).toEqual(DENIED);
    }
  });

  test('beats a tool rule ALLOW and a client rule ALLOW', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('ALLOW'), clientOverride: null, clientUpstream: null, denyPausedUntil: LIVE, now: NOW })).toEqual(DENIED);
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('ASK'), clientOverride: 'ALLOW', clientUpstream: null, denyPausedUntil: LIVE, now: NOW })).toEqual(DENIED);
  });

  test('beats a live allow pause', () => {
    expect(
      evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: null, clientUpstream: null, snoozedUntil: LIVE, denyPausedUntil: LIVE, now: NOW }),
    ).toEqual(DENIED);
  });

  test('applies to new and changed tools', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: null, clientUpstream: null, denyPausedUntil: LIVE, now: NOW })).toEqual(DENIED);
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: null, clientUpstream: null, denyPausedUntil: LIVE, now: NOW })).toEqual(DENIED);
  });

  test('unknown tool stays unknown-tool', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: null, clientOverride: null, clientUpstream: null, denyPausedUntil: LIVE, now: NOW })).toEqual({
      policy: 'DENY',
      path: 'unknown-tool',
    });
  });

  test('expired (until <= now) or absent: no effect', () => {
    for (const until of [NOW, new Date(NOW.getTime() - 1), null, undefined]) {
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: null, clientUpstream: null, denyPausedUntil: until, now: NOW })).toEqual({
        policy: 'ALLOW',
        path: 'policy:upstream-default',
      });
    }
  });

  test('fails closed: no now, an invalid date or garbage still denies', () => {
    const tool = known('ALLOW');
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool, clientOverride: null, clientUpstream: null, denyPausedUntil: LIVE })).toEqual(DENIED);
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool, clientOverride: null, clientUpstream: null, denyPausedUntil: new Date(NaN), now: NOW })).toEqual(DENIED);
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool, clientOverride: null, clientUpstream: null, denyPausedUntil: '2020-01-01' as never, now: NOW })).toEqual(DENIED);
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool, clientOverride: null, clientUpstream: null, denyPausedUntil: NOW, now: new Date(NaN) })).toEqual(DENIED);
  });
});

describe('AUTO (ADR-0030, TC-158 unit)', () => {
  const NOW = new Date('2026-10-04T12:00:00Z');
  const LATER = new Date('2026-10-04T13:00:00Z');
  test('AUTO resolves at the same steps as ALLOW/ASK/DENY', () => {
    expect(evaluatePolicy({ upstreamDefault: 'AUTO', tool: known(), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'AUTO', path: 'policy:upstream-default' });
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('AUTO'), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'AUTO', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('ALLOW'), clientOverride: 'AUTO', clientUpstream: null })).toEqual({ policy: 'AUTO', path: 'policy:client' });
  });
  test('precedence unchanged: tool DENY under default AUTO; client ASK over tool AUTO', () => {
    expect(evaluatePolicy({ upstreamDefault: 'AUTO', tool: known('DENY'), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'DENY', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'AUTO', tool: known('AUTO'), clientOverride: 'ASK', clientUpstream: null })).toEqual({ policy: 'ASK', path: 'policy:client' });
    expect(evaluatePolicy({ upstreamDefault: 'AUTO', tool: known('AUTO'), clientOverride: 'DENY', clientUpstream: null })).toEqual({ policy: 'DENY', path: 'policy:client' });
  });
  test('new and changed tools never resolve to AUTO, wherever AUTO is set', () => {
    for (const where of ['default', 'tool', 'client'] as const) {
      const inp = (tool: ReturnType<typeof known>) => ({
        upstreamDefault: (where === 'default' ? 'AUTO' : 'ASK') as Policy,
        tool: { ...tool, policy: where === 'tool' ? ('AUTO' as Policy) : null },
        clientOverride: where === 'client' ? ('AUTO' as Policy) : null,
        clientUpstream: null,
      });
      expect(evaluatePolicy(inp(known(null, null)))).toEqual({ policy: 'ASK', path: 'new-tool' });
      expect(evaluatePolicy(inp(changed()))).toEqual({ policy: 'ASK', path: 'changed-tool' });
    }
  });
  test('a live allow pause turns AUTO into ALLOW "snooze" (the ADR-0029 path); a deny pause wins', () => {
    expect(evaluatePolicy({ upstreamDefault: 'AUTO', tool: known(), clientOverride: null, clientUpstream: null, snoozedUntil: LATER, now: NOW })).toEqual({ policy: 'ALLOW', path: 'snooze' });
    expect(evaluatePolicy({ upstreamDefault: 'AUTO', tool: known(), clientOverride: null, clientUpstream: null, snoozedUntil: NOW, now: NOW })).toEqual({ policy: 'AUTO', path: 'policy:upstream-default' });
    expect(evaluatePolicy({ upstreamDefault: 'AUTO', tool: known(), clientOverride: null, clientUpstream: null, snoozedUntil: LATER, denyPausedUntil: LATER, now: NOW })).toEqual({ policy: 'DENY', path: 'snooze-deny' });
  });
  test('unrecognised values (typos, case, AUTO-like) are DENY', () => {
    for (const bad of ['AUTOO', 'auto', 'Auto', ' AUTO', 'AUTO ', 'ALLOW_AUTO', '', 7, null]) {
      expect(evaluatePolicy({ upstreamDefault: bad as Policy, tool: known(), clientOverride: null, clientUpstream: null }).policy).toBe(bad === null ? 'DENY' : 'DENY');
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(bad as Policy), clientOverride: null, clientUpstream: null }).policy).toBe(bad === null ? 'ALLOW' : 'DENY');
    }
  });
});

// TC-184 (ADR-0032): the client's default per upstream. DENY hides the
// upstream ("client-hidden") and beats everything but unknown-tool;
// ALLOW/ASK/AUTO replace the upstream default below tool rules and
// new/changed tools; garbage is hidden (fail closed).
describe('client default per upstream (TC-184)', () => {
  const NOW = new Date('2026-10-07T12:00:00Z');
  const LIVE = new Date('2026-10-07T12:15:00Z');
  const HIDDEN = { policy: 'DENY', path: 'client-hidden' };

  test('DENY hides against every other rule, pause and tool state', () => {
    const base = { clientUpstream: 'DENY' as Policy, now: NOW };
    for (const d of ['ALLOW', 'ASK', 'DENY', 'AUTO'] as const) {
      expect(evaluatePolicy({ ...base, upstreamDefault: d, tool: known(), clientOverride: null })).toEqual(HIDDEN);
    }
    // tool rule ALLOW, client tool rule ALLOW (masked, not reset)
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: known('ALLOW'), clientOverride: null })).toEqual(HIDDEN);
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: known(), clientOverride: 'ALLOW' })).toEqual(HIDDEN);
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: known('AUTO'), clientOverride: 'AUTO' })).toEqual(HIDDEN);
    // live allow pause: never upgraded (the post-step only touches ASK/AUTO)
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ASK', tool: known(), clientOverride: null, snoozedUntil: LIVE })).toEqual(HIDDEN);
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ASK', tool: known('ALLOW'), clientOverride: 'ASK', snoozedUntil: LIVE })).toEqual(HIDDEN);
    // live deny pause: the path stays client-hidden, not snooze-deny
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: known(), clientOverride: null, denyPausedUntil: LIVE })).toEqual(HIDDEN);
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: known(), clientOverride: null, snoozedUntil: LIVE, denyPausedUntil: LIVE })).toEqual(HIDDEN);
    // new and changed tools (with or without explicit rules)
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: null })).toEqual(HIDDEN);
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: 'ALLOW' })).toEqual(HIDDEN);
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: changed(), clientOverride: null })).toEqual(HIDDEN);
    expect(evaluatePolicy({ ...base, upstreamDefault: 'ALLOW', tool: changed('ALLOW'), clientOverride: 'ALLOW' })).toEqual(HIDDEN);
  });

  test('an unknown tool stays unknown-tool', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: null, clientOverride: null, clientUpstream: 'DENY' })).toEqual({ policy: 'DENY', path: 'unknown-tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: null, clientOverride: null, clientUpstream: 'ALLOW' })).toEqual({ policy: 'DENY', path: 'unknown-tool' });
  });

  test('ALLOW/ASK/AUTO apply as policy:client-upstream where no tool or client tool rule exists', () => {
    for (const cu of ['ALLOW', 'ASK', 'AUTO'] as const) {
      for (const d of ['ALLOW', 'ASK', 'DENY', 'AUTO'] as const) {
        expect(evaluatePolicy({ upstreamDefault: d, tool: known(), clientOverride: null, clientUpstream: cu })).toEqual({ policy: cu, path: 'policy:client-upstream' });
      }
    }
  });

  test('a client tool rule and a tool rule beat it (both directions)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('ASK'), clientOverride: null, clientUpstream: 'ALLOW' })).toEqual({ policy: 'ASK', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('ALLOW'), clientOverride: null, clientUpstream: 'ASK' })).toEqual({ policy: 'ALLOW', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('DENY'), clientOverride: null, clientUpstream: 'ALLOW' })).toEqual({ policy: 'DENY', path: 'policy:tool' });
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: 'DENY', clientUpstream: 'ALLOW' })).toEqual({ policy: 'DENY', path: 'policy:client' });
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known('ASK'), clientOverride: 'ALLOW', clientUpstream: 'ASK' })).toEqual({ policy: 'ALLOW', path: 'policy:client' });
  });

  test('new and changed tools stay ASK (ALLOW and AUTO never cover them)', () => {
    for (const cu of ['ALLOW', 'ASK', 'AUTO'] as const) {
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: null, clientUpstream: cu })).toEqual({ policy: 'ASK', path: 'new-tool' });
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: changed(), clientOverride: null, clientUpstream: cu })).toEqual({ policy: 'ASK', path: 'changed-tool' });
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ALLOW', ACK, CHANGED), clientOverride: null, clientUpstream: cu })).toEqual({ policy: 'ASK', path: 'changed-tool' });
      // and a live allow pause can't carry them either
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(null, null), clientOverride: null, clientUpstream: cu, snoozedUntil: LIVE, now: NOW })).toEqual({ policy: 'ASK', path: 'new-tool' });
    }
  });

  test('an allow pause upgrades a client-upstream ASK/AUTO (snooze), never ALLOW-rewrites; a deny pause wins', () => {
    for (const cu of ['ASK', 'AUTO'] as const) {
      expect(evaluatePolicy({ upstreamDefault: 'DENY', tool: known(), clientOverride: null, clientUpstream: cu, snoozedUntil: LIVE, now: NOW })).toEqual({ policy: 'ALLOW', path: 'snooze' });
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: null, clientUpstream: cu, denyPausedUntil: LIVE, now: NOW })).toEqual({ policy: 'DENY', path: 'snooze-deny' });
    }
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: null, clientUpstream: 'ALLOW', snoozedUntil: LIVE, now: NOW })).toEqual({ policy: 'ALLOW', path: 'policy:client-upstream' });
  });

  test('unrecognised values are DENY client-hidden (fail closed)', () => {
    for (const bad of ['AUTOO', 'allow', 'Allow', ' ALLOW', 'ALLOW ', 'always_allow', '', 7, {}, true]) {
      expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known('ALLOW'), clientOverride: 'ALLOW', clientUpstream: bad as unknown as Policy })).toEqual(HIDDEN);
    }
  });

  test('null and undefined mean "Voreinst." (the upstream default)', () => {
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: null, clientUpstream: null })).toEqual({ policy: 'ASK', path: 'policy:upstream-default' });
    expect(evaluatePolicy({ upstreamDefault: 'ASK', tool: known(), clientOverride: null, clientUpstream: undefined as unknown as null })).toEqual({ policy: 'ASK', path: 'policy:upstream-default' });
  });

  test('clientUpstream is a required input (type level)', () => {
    // @ts-expect-error clientUpstream missing
    const missing: Parameters<typeof evaluatePolicy>[0] = { upstreamDefault: 'ASK', tool: known(), clientOverride: null };
    expect(missing.clientUpstream).toBeUndefined();
  });
});
