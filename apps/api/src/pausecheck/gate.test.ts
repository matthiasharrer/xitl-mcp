// ADR-0029 gate: `narrow` can only narrow (TC-141), `evaluate` stays blind when
// off / unanchored / switched off (TC-142, TC-146), fails closed on errors
// (TC-140), ends the pause on a mismatch (TC-138), scopes "calls since" to
// this pause, user, client and upstream (TC-144), and `serial` keeps order.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const userFind = vi.fn();
const auditFindFirst = vi.fn();
const auditFindMany = vi.fn();
const snoozeDelete = vi.fn();
vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: userFind },
    auditEntry: { findFirst: auditFindFirst, findMany: auditFindMany },
    snooze: { deleteMany: snoozeDelete },
  },
}));

const { narrow, PauseGate } = await import('./gate.js');
const { blocksOf } = await import('./prompt.js');
import type { PauseCheck, PauseCheckAnswer } from './check.js';
import type { PolicyDecision } from '../lib/policy.js';

const answer = (gleich: number, w = 1 - gleich, x = 0): PauseCheckAnswer => ({ choice: 'gleich', probabilities: { gleich, richtungswechsel: w, ausweitung: x } });
const fakeCheck = (impl: (state: string, signal: AbortSignal) => Promise<PauseCheckAnswer>) => {
  const check = vi.fn(impl);
  return { check: { check } as PauseCheck, spy: check };
};
const config = (c: PauseCheck, timeoutMs = 1000) => ({ check: c, threshold: 0.8, timeoutMs, host: 'clef' });
const input = (anchorAuditId: number | null = 7) => ({
  userId: 1,
  mcpClientId: 10,
  upstreamId: 5,
  pause: { id: 42, until: new Date(Date.UTC(2026, 9, 7, 13)), anchorAuditId },
  call: { upstream: 'Haushalt', tool: 'add_item', args: { item: 'neu' } },
});
const quiet = { log: () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  userFind.mockResolvedValue({ pauseCheck: true });
  auditFindFirst.mockResolvedValue({ toolName: 'add_item', arguments: '{"item":"erst"}', intentStatus: 'DONE', intentSummary: 'legt „erst“ an.', upstream: { name: 'Haushalt' } });
  auditFindMany.mockResolvedValue([
    { toolName: 'add_item', arguments: '{"item":"B2"}', upstream: { name: 'Haushalt' } },
    { toolName: 'add_item', arguments: '{"item":"B1"}', upstream: { name: 'Haushalt' } },
  ]);
  snoozeDelete.mockResolvedValue({ count: 1 });
});

describe('narrow (TC-141: the check only narrows)', () => {
  const all: PolicyDecision[] = [
    { policy: 'ALLOW', path: 'policy:tool' },
    { policy: 'ALLOW', path: 'policy:upstream-default' },
    { policy: 'DENY', path: 'snooze-deny' },
    { policy: 'DENY', path: 'policy:tool' },
    { policy: 'ASK', path: 'new-tool' },
    { policy: 'ASK', path: 'policy:upstream-default' },
  ];
  const results = [{ kind: 'match', score: 0.99, choice: 'gleich' }, { kind: 'mismatch', score: 0.1, choice: 'ausweitung' }, { kind: 'error' }, { kind: 'blind' }] as const;
  it('anything but ALLOW via snooze is unchanged, whatever the check says', () => {
    for (const d of all) for (const r of results) expect(narrow(d, r)).toEqual(d);
  });
  it('ALLOW via snooze: match -> snooze+ki, mismatch -> ASK, error -> ASK, blind/none -> unchanged', () => {
    const d: PolicyDecision = { policy: 'ALLOW', path: 'snooze' };
    expect(narrow(d, results[0])).toEqual({ policy: 'ALLOW', path: 'snooze+ki' });
    expect(narrow(d, results[1])).toEqual({ policy: 'ASK', path: 'snooze-ki-mismatch' });
    expect(narrow(d, results[2])).toEqual({ policy: 'ASK', path: 'snooze-ki-error' });
    expect(narrow(d, { kind: 'whatever' } as never)).toEqual({ policy: 'ASK', path: 'snooze-ki-error' });
    expect(narrow(d, results[3])).toEqual(d);
    expect(narrow(d, null)).toEqual(d);
  });
});

describe('PauseGate.evaluate', () => {
  it('TC-142: feature off -> blind, nothing read, nothing sent', async () => {
    const g = new PauseGate(null, quiet);
    expect(g.enabled).toBe(false);
    expect(await g.evaluate(input())).toEqual({ kind: 'blind' });
    expect(await g.active(1)).toBe(false);
    expect(userFind).not.toHaveBeenCalled();
  });

  it('TC-146: a pause without anchor -> blind, model never called', async () => {
    const { check, spy } = fakeCheck(async () => answer(0.99));
    expect(await new PauseGate(config(check), quiet).evaluate(input(null))).toEqual({ kind: 'blind' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('TC-142: the user switch off -> blind, model never called', async () => {
    userFind.mockResolvedValue({ pauseCheck: false });
    const { check, spy } = fakeCheck(async () => answer(0.99));
    expect(await new PauseGate(config(check), quiet).evaluate(input())).toEqual({ kind: 'blind' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('TC-137/TC-144: match; state = anchor + its summary + calls since (scoped, oldest first) + new call', async () => {
    const { check, spy } = fakeCheck(async () => answer(0.95));
    const g = new PauseGate(config(check), quiet);
    expect(await g.evaluate(input())).toEqual({ kind: 'match', score: 0.95, choice: 'gleich' });
    expect(auditFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7, userId: 1 } }));
    const q = auditFindMany.mock.calls[0]![0];
    expect(q.where).toEqual({ userId: 1, mcpClientId: 10, upstreamId: 5, pauseSnoozeId: 42, outcome: { in: ['FORWARDED', 'UPSTREAM_ERROR', 'PENDING'] } });
    expect(q.orderBy).toEqual({ id: 'desc' });
    expect(q.take).toBe(8);
    const state = spy.mock.calls[0]![0];
    expect(blocksOf(state).map((b) => (b.arguments as { item: string }).item)).toEqual(['erst', 'B1', 'B2', 'neu']);
    expect(state).toContain('Summary of that call (by the proxy, German): "legt „erst“ an."');
    expect(snoozeDelete).not.toHaveBeenCalled();
  });

  it('TC-138: mismatch ends exactly this pause (user-scoped)', async () => {
    const { check } = fakeCheck(async () => answer(0.1, 0.85, 0.05));
    expect(await new PauseGate(config(check), quiet).evaluate(input())).toEqual({ kind: 'mismatch', score: 0.1, choice: 'richtungswechsel' });
    expect(snoozeDelete).toHaveBeenCalledWith({ where: { userId: 1, mcpClientId: 10, upstreamId: 5, effect: 'ALLOW' } });
  });

  it('TC-140: rejection, timeout, missing anchor -> error; the pause stays; outage raised and cleared by the next success', async () => {
    let mode: 'fail' | 'hang' | 'ok' = 'fail';
    const { check } = fakeCheck(
      (_s, signal) =>
        mode === 'ok'
          ? Promise.resolve(answer(0.9))
          : mode === 'fail'
            ? Promise.reject(new Error('HTTP 500'))
            : new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const g = new PauseGate(config(check, 20), quiet);
    const events: (string | null)[] = [];
    g.outage.on((e) => events.push(e.since));
    expect(await g.evaluate(input())).toEqual({ kind: 'error' });
    expect(g.outage.since(1)).not.toBeNull();
    mode = 'hang';
    expect(await g.evaluate(input())).toEqual({ kind: 'error' });
    expect(events).toHaveLength(1); // one outage, one start event
    expect(snoozeDelete).not.toHaveBeenCalled();
    mode = 'ok';
    expect((await g.evaluate(input())).kind).toBe('match');
    expect(g.outage.since(1)).toBeNull();
    expect(events).toHaveLength(2);
    expect(events[1]).toBeNull();
    // Anchor row gone: held, but that is not a model outage.
    auditFindFirst.mockResolvedValue(null);
    expect(await g.evaluate(input())).toEqual({ kind: 'error' });
    expect(g.outage.since(1)).toBeNull();
  });

  it('only the failing user gets the outage', async () => {
    const { check } = fakeCheck(async () => Promise.reject(new Error('down')));
    const g = new PauseGate(config(check), quiet);
    await g.evaluate(input());
    expect(g.outage.since(1)).not.toBeNull();
    expect(g.outage.since(2)).toBeNull();
  });
});

describe('PauseGate.serial', () => {
  it('runs one access strictly in order; other accesses do not wait; a failure does not break the chain', async () => {
    const g = new PauseGate(null, quiet);
    const order: string[] = [];
    let release!: () => void;
    const gate1 = new Promise<void>((r) => (release = r));
    const a = g.serial(1, 10, async () => {
      await gate1;
      order.push('a');
      throw new Error('boom');
    });
    const b = g.serial(1, 10, async () => void order.push('b'));
    const c = g.serial(1, 11, async () => void order.push('c'));
    await c;
    expect(order).toEqual(['c']);
    release();
    await expect(a).rejects.toThrow('boom');
    await b;
    expect(order).toEqual(['c', 'a', 'b']);
  });
});
