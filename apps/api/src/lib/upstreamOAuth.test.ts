// Connect-flow state, pending-auth checks and token expiry (TC-16, TC-17 unit
// side). Time from fixedClock (ADR-0003).
import { describe, expect, test } from 'vitest';
import { fixedClock } from './clock.js';
import {
  PENDING_TTL_MS,
  checkPending,
  expiryFrom,
  isNavigableUrl,
  makeState,
  needsRefresh,
  parsePending,
  upstreamIdFromState,
  type PendingAuth,
} from './upstreamOAuth.js';

describe('state', () => {
  test('carries the upstream id and a long random part, different every time', () => {
    const a = makeState(42);
    const b = makeState(42);
    expect(a).not.toBe(b);
    expect(upstreamIdFromState(a)).toBe(42);
    expect(a.split('.')[1]!.length).toBeGreaterThanOrEqual(40);
  });

  test('malformed states are refused', () => {
    for (const bad of [undefined, '', '42', '42.', 'abc.def', '42.short', '-1.' + 'a'.repeat(43), '42.' + 'a'.repeat(43) + '!', 42]) {
      expect(upstreamIdFromState(bad as unknown)).toBeNull();
    }
  });
});

describe('checkPending', () => {
  const clock = fixedClock('2026-10-04T12:00:00Z');
  const state = makeState(7);
  const pending: PendingAuth = {
    state,
    codeVerifier: 'v',
    redirectUri: 'https://x/api/upstreams/oauth/callback',
    expiresAt: new Date(clock.now().getTime() + PENDING_TTL_MS).toISOString(),
  };

  test('the right state within 10 minutes is ok', () => {
    expect(checkPending(pending, state, clock.now())).toBe('ok');
  });
  test('another state (same upstream id) is a mismatch', () => {
    expect(checkPending(pending, makeState(7), clock.now())).toBe('mismatch');
  });
  test('no pending flow is missing', () => {
    expect(checkPending(null, state, clock.now())).toBe('missing');
    expect(parsePending(null)).toBeNull();
    expect(parsePending('not json')).toBeNull();
    expect(parsePending('{"state":1}')).toBeNull();
  });
  test('expires after 10 minutes', () => {
    const c = fixedClock(clock.now());
    c.advance(PENDING_TTL_MS - 1);
    expect(checkPending(pending, state, c.now())).toBe('ok');
    c.advance(1);
    expect(checkPending(pending, state, c.now())).toBe('expired');
  });
  test('a garbage expiry fails closed', () => {
    expect(checkPending({ ...pending, expiresAt: 'never' }, state, clock.now())).toBe('expired');
  });
  test('round-trips through JSON', () => {
    expect(parsePending(JSON.stringify(pending))).toEqual(pending);
  });
});

describe('token expiry', () => {
  const clock = fixedClock('2026-10-04T12:00:00Z');
  test('expires_in becomes an absolute time; missing/invalid means unknown', () => {
    expect(expiryFrom(3600, clock.now())?.toISOString()).toBe('2026-10-04T13:00:00.000Z');
    expect(expiryFrom(undefined, clock.now())).toBeNull();
    expect(expiryFrom(0, clock.now())).toBeNull();
    expect(expiryFrom(Number.NaN, clock.now())).toBeNull();
  });
  test('refresh when expired or within 60 s of expiry, not before', () => {
    const exp = expiryFrom(3600, clock.now())!;
    const c = fixedClock(clock.now());
    expect(needsRefresh(exp, c.now())).toBe(false);
    c.advance(3600_000 - 61_000);
    expect(needsRefresh(exp, c.now())).toBe(false);
    c.advance(1_000);
    expect(needsRefresh(exp, c.now())).toBe(true);
    c.advance(120_000);
    expect(needsRefresh(exp, c.now())).toBe(true);
    expect(needsRefresh(null, c.now())).toBe(false);
  });
});

test('only http(s) URLs are navigable', () => {
  expect(isNavigableUrl('https://as.example/authorize?x=1')).toBe(true);
  expect(isNavigableUrl('http://127.0.0.1:3210/authorize')).toBe(true);
  expect(isNavigableUrl('javascript:alert(1)')).toBe(false);
  expect(isNavigableUrl('data:text/html,hi')).toBe(false);
  expect(isNavigableUrl('nonsense')).toBe(false);
});
