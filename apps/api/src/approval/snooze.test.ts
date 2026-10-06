// Snooze scopes (TC-76 unit part): which rows cover which tool.
import { describe, expect, it } from 'vitest';
import { covers, isAllow, isReadOnly, latestCovering, pauseState } from './snooze.js';
import { heldCoveredBy } from './snooze.js';

const d = (m: number) => new Date(Date.UTC(2026, 9, 5, 12, m));

describe('snooze scopes', () => {
  it('TOOL covers exactly its tool', () => {
    expect(covers({ scope: 'TOOL', toolName: 'list' }, 'list', true)).toBe(true);
    expect(covers({ scope: 'TOOL', toolName: 'list' }, 'add', true)).toBe(false);
  });

  it('READONLY covers read-only tools only', () => {
    expect(covers({ scope: 'READONLY', toolName: null }, 'list', true)).toBe(true);
    expect(covers({ scope: 'READONLY', toolName: null }, 'add', false)).toBe(false);
  });

  it('UPSTREAM covers every tool', () => {
    expect(covers({ scope: 'UPSTREAM', toolName: null }, 'delete_all', false)).toBe(true);
  });

  it('a TOOL row without a name covers nothing (fail closed)', () => {
    expect(covers({ scope: 'TOOL', toolName: null }, 'list', true)).toBe(false);
  });

  it('takes the latest covering row', () => {
    const rows = [
      { scope: 'TOOL' as const, toolName: 'add', until: d(30) },
      { scope: 'READONLY' as const, toolName: null, until: d(50) },
      { scope: 'UPSTREAM' as const, toolName: null, until: d(20) },
    ];
    expect(latestCovering(rows, 'add', false)).toEqual(d(30));
    expect(latestCovering(rows, 'list', true)).toEqual(d(50));
    expect(latestCovering(rows, 'other', false)).toEqual(d(20));
    expect(latestCovering([], 'x', true)).toBeNull();
  });

  it('reads read-only from stored annotations', () => {
    expect(isReadOnly('{"readOnlyHint":true}')).toBe(true);
    expect(isReadOnly('{"readOnlyHint":true,"destructiveHint":true}')).toBe(true);
    expect(isReadOnly('{"readOnlyHint":false}')).toBe(false);
    expect(isReadOnly(null)).toBe(false);
    expect(isReadOnly('not json')).toBe(false);
  });
});

// TC-121 (matching half): which live pauses cover a call, split by effect.
// The DB query scopes by (user, upstream, client); here: scope, tool, expiry,
// and that only exactly 'ALLOW' is an allow pause.
describe('pause effects (TC-121, ADR-0026)', () => {
  const NOW = d(0);
  const row = (effect: string, scope: 'TOOL' | 'READONLY' | 'UPSTREAM', toolName: string | null, until: Date) => ({ effect, scope, toolName, until });

  it('a deny pause never acts as an allow pause', () => {
    const rows = [row('DENY', 'TOOL', 'add', d(30))];
    expect(pauseState(rows, 'add', false, NOW)).toEqual({ allowUntil: null, denyUntil: d(30), denyScope: 'TOOL' });
  });

  it('an unrecognised effect is DENY (fail closed)', () => {
    for (const effect of ['allow', 'ALLOW ', '', 'X', 'deny']) {
      expect(isAllow({ effect })).toBe(false);
      expect(pauseState([row(effect, 'TOOL', 'add', d(30))], 'add', false, NOW)).toEqual({ allowUntil: null, denyUntil: d(30), denyScope: 'TOOL' });
    }
    expect(isAllow({ effect: 'ALLOW' })).toBe(true);
  });

  it('TOOL scope: only that tool; UPSTREAM scope: every tool', () => {
    expect(pauseState([row('DENY', 'TOOL', 'add', d(30))], 'other', false, NOW).denyUntil).toBeNull();
    expect(pauseState([row('DENY', 'UPSTREAM', null, d(30))], 'anything', false, NOW).denyUntil).toEqual(d(30));
  });

  it('expired rows have no effect', () => {
    expect(pauseState([row('DENY', 'UPSTREAM', null, NOW), row('ALLOW', 'UPSTREAM', null, d(-1))], 'add', false, NOW)).toEqual({
      allowUntil: null,
      denyUntil: null,
      denyScope: null,
    });
  });

  it('both effects live: both reported (the policy lets deny win)', () => {
    const rows = [row('ALLOW', 'TOOL', 'add', d(60)), row('DENY', 'UPSTREAM', null, d(15))];
    expect(pauseState(rows, 'add', false, NOW)).toEqual({ allowUntil: d(60), denyUntil: d(15), denyScope: 'UPSTREAM' });
  });
});

describe('heldCoveredBy (TC-128: a pause also settles the held calls it covers)', () => {
  const call = (id: string, o: Partial<{ userId: number; mcpClientId: number; upstreamId: number; toolName: string; readOnly: boolean; snoozable: boolean }> = {}) => ({
    id, userId: 1, mcpClientId: 10, upstreamId: 5, toolName: 'get_recipe', readOnly: true, snoozable: true, ...o,
  });
  const origin = call('o');
  const held = [
    origin,
    call('same'),
    call('other-tool', { toolName: 'update_recipe', readOnly: false }),
    call('other-client', { mcpClientId: 11 }),
    call('other-upstream', { upstreamId: 6 }),
    call('other-user', { userId: 2 }),
    call('new-tool', { snoozable: false }),
  ];
  const ids = (r: { id: string }[]) => r.map((c) => c.id).sort();

  it('TOOL allow: same client, upstream and tool only; never the origin, never a new/changed tool', () => {
    expect(ids(heldCoveredBy(origin, held, 'TOOL', 'ALLOW'))).toEqual(['same']);
  });
  it('UPSTREAM allow: every snoozable tool of that client + upstream', () => {
    expect(ids(heldCoveredBy(origin, held, 'UPSTREAM', 'ALLOW'))).toEqual(['other-tool', 'same']);
  });
  it('READONLY allow: read-only tools only', () => {
    expect(ids(heldCoveredBy(origin, held, 'READONLY', 'ALLOW'))).toEqual(['same']);
  });
  it('DENY takes new/changed tools too (only tightens), still never another client/upstream/user', () => {
    expect(ids(heldCoveredBy(origin, held, 'TOOL', 'DENY'))).toEqual(['new-tool', 'same']);
    expect(ids(heldCoveredBy(origin, held, 'UPSTREAM', 'DENY'))).toEqual(['new-tool', 'other-tool', 'same']);
  });
});
