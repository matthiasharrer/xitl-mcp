// ADR-0022 / TC-94 (unit): upstream push on transitions, with a 1 h cooldown
// per upstream (injected Clock), owner's subscriptions only, names + state only.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const upstreamFindFirst = vi.fn();
const subsFindMany = vi.fn();
vi.mock('../db.js', () => ({
  prisma: { upstream: { findFirst: upstreamFindFirst }, pushSubscription: { findMany: subsFindMany } },
}));
const { PushCooldown, wireUpstreamPush, UPSTREAM_PUSH_COOLDOWN_MS } = await import('./notify.js');
const { UpstreamStateEvents } = await import('./stateEvents.js');

let now = new Date('2026-10-05T12:00:00Z');
const clock = { now: () => now };
const later = (ms: number) => (now = new Date(now.getTime() + ms));

describe('PushCooldown', () => {
  beforeEach(() => (now = new Date('2026-10-05T12:00:00Z')));

  test('one per key per hour; other keys independent; open again after the hour', () => {
    const c = new PushCooldown(clock);
    expect(c.take(1)).toBe(true);
    expect(c.take(1)).toBe(false);
    expect(c.take(2)).toBe(true);
    later(UPSTREAM_PUSH_COOLDOWN_MS - 1);
    expect(c.take(1)).toBe(false);
    later(1);
    expect(c.take(1)).toBe(true);
    expect(c.take(1)).toBe(false);
  });
});

describe('wireUpstreamPush', () => {
  const sent: { sub: unknown; payload: unknown; opts: unknown }[] = [];
  const deps = {
    transport: async (sub: unknown, payload: unknown, opts: unknown) => void sent.push({ sub, payload, opts }),
    onGone: async () => undefined,
    onSuccess: async () => undefined,
    log: () => undefined,
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    now = new Date('2026-10-05T12:00:00Z');
    sent.length = 0;
    upstreamFindFirst.mockReset().mockResolvedValue({ id: 5, name: 'Haushalt', pausedAt: null });
    subsFindMany.mockReset().mockResolvedValue([{ id: 1, endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);
  });

  test('transition into unreachable/reconnect pushes name + state to the owner; ok and edits do not', async () => {
    const states = new UpstreamStateEvents();
    wireUpstreamPush(states, { clock, deps });
    states.emit({ userId: 3, upstreamId: 5, state: 'ok', cause: 'transition' });
    states.emit({ userId: 3, upstreamId: 5, state: 'unreachable', cause: 'edit' });
    await flush();
    expect(sent).toHaveLength(0);

    states.emit({ userId: 3, upstreamId: 5, state: 'unreachable', cause: 'transition' });
    await flush();
    expect(upstreamFindFirst).toHaveBeenCalledWith({ where: { id: 5, userId: 3 }, select: { id: true, name: true, pausedAt: true } });
    expect(subsFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 3 } }));
    expect(sent).toEqual([
      {
        sub: expect.anything(),
        payload: { type: 'upstream', upstreamId: 5, name: 'Haushalt', state: 'unreachable' },
        opts: { ttl: 3600, urgency: 'normal' },
      },
    ]);
  });

  test('cooldown: a second transition within the hour (any state) is not pushed; after it, it is', async () => {
    const states = new UpstreamStateEvents();
    wireUpstreamPush(states, { clock, deps });
    states.emit({ userId: 3, upstreamId: 5, state: 'unreachable', cause: 'transition' });
    states.emit({ userId: 3, upstreamId: 5, state: 'reconnect', cause: 'transition' });
    later(30 * 60_000);
    states.emit({ userId: 3, upstreamId: 5, state: 'unreachable', cause: 'transition' });
    await flush();
    expect(sent).toHaveLength(1);
    later(30 * 60_000);
    states.emit({ userId: 3, upstreamId: 5, state: 'reconnect', cause: 'transition' });
    await flush();
    expect(sent).toHaveLength(2);
    expect((sent[1]!.payload as { state: string }).state).toBe('reconnect');
  });

  test('a paused upstream (ADR-0033) is never pushed about', async () => {
    upstreamFindFirst.mockResolvedValue({ id: 5, name: 'Haushalt', pausedAt: new Date('2026-10-07T10:00:00Z') });
    const states = new UpstreamStateEvents();
    wireUpstreamPush(states, { clock, deps });
    states.emit({ userId: 3, upstreamId: 5, state: 'unreachable', cause: 'transition' });
    await flush();
    expect(sent).toHaveLength(0);
  });

  test('upstream gone (or foreign): nothing sent, nothing thrown', async () => {
    upstreamFindFirst.mockResolvedValue(null);
    const states = new UpstreamStateEvents();
    wireUpstreamPush(states, { clock, deps });
    expect(() => states.emit({ userId: 3, upstreamId: 5, state: 'unreachable', cause: 'transition' })).not.toThrow();
    await flush();
    expect(sent).toHaveLength(0);
  });
});
