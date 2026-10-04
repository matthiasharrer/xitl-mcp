// Pending approvals (ADR-0004): one outcome per call, user-scoped decisions,
// Clock/timer-driven timeout, abort and shutdown deny. Fake timers + fixedClock.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fixedClock } from '../lib/clock.js';
import { ApprovalHub, type NewPending } from './pending.js';
import { MAX_HELD_CALLS_PER_USER } from '../lib/limits.js';

const T0 = '2026-10-04T12:00:00Z';

function call(over: Partial<NewPending> = {}): NewPending {
  return {
    userId: 1,
    mcpClientId: 10,
    clientName: 'Claude',
    upstreamId: 5,
    upstreamSlug: 'haushalt',
    upstreamName: 'Haushalt',
    toolName: 'add_item',
    args: { item: 'Eier' },
    auditId: 99,
    rulePath: 'policy:upstream-default',
    receivedAt: new Date(T0),
    deadline: new Date(new Date(T0).getTime() + 300_000),
    snoozable: true,
    ...over,
  };
}

describe('ApprovalHub', () => {
  let clock: ReturnType<typeof fixedClock>;
  let hub: ApprovalHub;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = fixedClock(T0);
    hub = new ApprovalHub(clock);
  });
  afterEach(() => vi.useRealTimers());

  test('ids are unguessable-looking and validated', () => {
    const ids = new Set(Array.from({ length: 200 }, () => ApprovalHub.newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(ApprovalHub.isId(id)).toBe(true);
    expect(ApprovalHub.isId('1')).toBe(false);
    expect(ApprovalHub.isId('../../etc/passwd/xxxxxxx')).toBe(false);
  });

  test('approve resolves once; the first decision wins, later ones find nothing', async () => {
    const { call: c, decision } = hub.hold(call());
    expect(hub.list(1)).toHaveLength(1);
    expect(hub.decide(1, c.id, { kind: 'approve', via: 'page', snoozeUntil: null })).toBe('ok');
    expect(hub.decide(1, c.id, { kind: 'deny', via: 'push' })).toBe('not-found');
    await expect(decision).resolves.toMatchObject({ kind: 'approve', via: 'page' });
    expect(hub.list(1)).toHaveLength(0);
  });

  test('another user can neither see nor decide the call', async () => {
    const { call: c, decision } = hub.hold(call());
    expect(hub.get(2, c.id)).toBeNull();
    expect(hub.list(2)).toEqual([]);
    expect(hub.decide(2, c.id, { kind: 'approve', via: 'page', snoozeUntil: null })).toBe('not-found');
    expect(hub.get(1, c.id)).not.toBeNull();
    hub.decide(1, c.id, { kind: 'deny', via: 'page' });
    await expect(decision).resolves.toMatchObject({ kind: 'deny' });
  });

  test('no decision by the deadline -> timeout (deny); a decision after it is refused', async () => {
    const onResolved = vi.fn();
    hub.on('resolved', onResolved);
    const { call: c, decision } = hub.hold(call({ deadline: new Date(new Date(T0).getTime() + 3_000) }));
    vi.advanceTimersByTime(2_999);
    expect(hub.get(1, c.id)).not.toBeNull();
    clock.advance(3_000);
    vi.advanceTimersByTime(1);
    await expect(decision).resolves.toMatchObject({ kind: 'timeout' });
    expect(hub.decide(1, c.id, { kind: 'approve', via: 'page', snoozeUntil: null })).toBe('not-found');
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  test('a decision clears the timer (no late timeout event)', async () => {
    const onResolved = vi.fn();
    hub.on('resolved', onResolved);
    const { call: c } = hub.hold(call());
    hub.decide(1, c.id, { kind: 'approve', via: 'push', snoozeUntil: null });
    vi.advanceTimersByTime(600_000);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0]![0].decision.kind).toBe('approve');
  });

  test('client abort denies; shutdown denies everything and refuses new holds', async () => {
    const a = hub.hold(call());
    const b = hub.hold(call({ userId: 2 }));
    hub.abort(a.call.id);
    await expect(a.decision).resolves.toMatchObject({ kind: 'aborted' });
    hub.shutdown();
    await expect(b.decision).resolves.toMatchObject({ kind: 'shutdown' });
    const late = hub.hold(call());
    await expect(late.decision).resolves.toMatchObject({ kind: 'shutdown' });
    expect(hub.size).toBe(0);
  });

  test('events carry the owner so channels can filter; a throwing listener breaks nothing', async () => {
    const seen: number[] = [];
    hub.on('pending', (c) => seen.push(c.userId));
    hub.on('pending', () => {
      throw new Error('broken channel');
    });
    const { call: c, decision } = hub.hold(call({ userId: 7 }));
    expect(seen).toEqual([7]);
    expect(hub.decide(7, c.id, { kind: 'deny', via: 'page' })).toBe('ok');
    await expect(decision).resolves.toMatchObject({ kind: 'deny' });
  });

  // TC-41: revoking a client / deleting an upstream ends its held calls.
  test('cancelWhere settles matching calls as revoked (once), leaves others; later decisions find nothing', async () => {
    const onResolved = vi.fn();
    hub.on('resolved', onResolved);
    const a = hub.hold(call({ mcpClientId: 10 }));
    const b = hub.hold(call({ mcpClientId: 11 }));
    const other = hub.hold(call({ userId: 2, mcpClientId: 10 }));
    expect(hub.cancelWhere((c) => c.userId === 1 && c.mcpClientId === 10)).toBe(1);
    await expect(a.decision).resolves.toMatchObject({ kind: 'revoked' });
    expect(hub.decide(1, a.call.id, { kind: 'approve', via: 'page', snoozeUntil: null })).toBe('not-found');
    expect(hub.get(1, b.call.id)).not.toBeNull();
    expect(hub.get(2, other.call.id)).not.toBeNull();
    expect(hub.cancelWhere((c) => c.userId === 1 && c.upstreamId === 5)).toBe(1);
    await expect(b.decision).resolves.toMatchObject({ kind: 'revoked' });
    expect(onResolved.mock.calls.map((x) => x[0].decision.kind)).toEqual(['revoked', 'revoked']);
    vi.advanceTimersByTime(600_000); // no late timeout for the revoked ones
    expect(onResolved).toHaveBeenCalledTimes(3); // only `other` timed out
  });

  // TC-45: at most N held calls per user; the next one is refused at once and never announced.
  test('the call over the per-user cap settles as flood without a pending event; other users unaffected', async () => {
    expect(MAX_HELD_CALLS_PER_USER).toBe(10);
    const onPending = vi.fn();
    hub.on('pending', onPending);
    const held = Array.from({ length: MAX_HELD_CALLS_PER_USER }, () => hub.hold(call()));
    expect(onPending).toHaveBeenCalledTimes(MAX_HELD_CALLS_PER_USER);
    const over = hub.hold(call());
    await expect(over.decision).resolves.toMatchObject({ kind: 'flood' });
    expect(onPending).toHaveBeenCalledTimes(MAX_HELD_CALLS_PER_USER);
    expect(hub.list(1)).toHaveLength(MAX_HELD_CALLS_PER_USER);
    expect(hub.get(1, over.call.id)).toBeNull();
    const anna = hub.hold(call({ userId: 2 }));
    expect(hub.get(2, anna.call.id)).not.toBeNull();
    // a slot frees up once one is decided
    hub.decide(1, held[0]!.call.id, { kind: 'deny', via: 'page' });
    const next = hub.hold(call());
    expect(hub.get(1, next.call.id)).not.toBeNull();
  });

  test('the cap is configurable (tests)', async () => {
    const small = new ApprovalHub(clock, { maxHeldPerUser: 1 });
    small.hold(call());
    await expect(small.hold(call()).decision).resolves.toMatchObject({ kind: 'flood' });
  });
});
