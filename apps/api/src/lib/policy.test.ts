// TC-24: policy precedence. client override > tool policy > unacknowledged
// tool (= ASK) > upstream default; unknown tool = DENY; every result names its
// decision path; garbage fails closed.
import { describe, expect, test } from 'vitest';
import { evaluatePolicy, type Policy } from './policy.js';

const ACK = new Date('2026-10-04T10:00:00Z');
const known = (policy: Policy | null = null, acknowledgedAt: Date | null = ACK) => ({ policy, acknowledgedAt });

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

  test('garbage policy values fail closed to DENY', () => {
    const bad = 'always_allow' as unknown as Policy;
    expect(evaluatePolicy({ upstreamDefault: bad, tool: known(), clientOverride: null }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(bad), clientOverride: null }).policy).toBe('DENY');
    expect(evaluatePolicy({ upstreamDefault: 'ALLOW', tool: known(), clientOverride: bad }).policy).toBe('DENY');
  });
});
