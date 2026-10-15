// ADR-0029 amendment (TC-217, TC-219, TC-221): an interrupted pause is never
// live, and resuming only touches the caller's interrupted, live ALLOW rows.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const updateMany = vi.fn();
vi.mock('../db.js', () => ({ prisma: { snooze: { findMany, updateMany } } }));
vi.mock('../lib/pauseEvents.js', () => ({ pauseEvents: { emit: vi.fn() } }));

const { livePauses, resumeAllowPauses } = await import('./snooze.js');

const now = new Date(Date.UTC(2026, 9, 15, 12));

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
});

describe('interrupted pauses', () => {
  it('TC-217: the live loader reads only rows that are not interrupted', async () => {
    findMany.mockResolvedValue([]);
    await livePauses({ userId: 1, upstreamId: 5, mcpClientId: 10 }, 'add_item', false, now);
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: 1, upstreamId: 5, mcpClientId: 10, until: { gt: now }, suspendedAt: null });
  });

  it('TC-219/TC-221: resume is scoped to the caller, ALLOW, interrupted and live; sets the anchor only when given', async () => {
    findMany.mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([{ id: 42, scope: 'TOOL', until: new Date(now.getTime() + 60_000), anchorAuditId: 99, purpose: 'Einkauf', purposeSource: 'typed' }]);
    const r = await resumeAllowPauses(1, [42, 43], now, 99);
    const where = { userId: 1, id: { in: [42, 43] }, effect: 'ALLOW', suspendedAt: { not: null }, until: { gt: now } };
    expect(findMany.mock.calls[0][0].where).toEqual(where);
    expect(updateMany).toHaveBeenCalledWith({ where: { ...where, id: { in: [42] } }, data: { suspendedAt: null, anchorAuditId: 99 } });
    expect(r).toEqual([{ scope: 'TOOL', pause: { id: 42, until: expect.any(Date), anchorAuditId: 99, purpose: 'Einkauf', purposeSource: 'typed' } }]);

    vi.clearAllMocks();
    findMany.mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([]);
    await resumeAllowPauses(1, [42], now);
    expect(updateMany.mock.calls[0][0].data).toEqual({ suspendedAt: null });
  });

  it('TC-219: nothing to resume -> no write', async () => {
    findMany.mockResolvedValue([]);
    expect(await resumeAllowPauses(1, [42], now, 99)).toEqual([]);
    expect(await resumeAllowPauses(1, [], now, 99)).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
