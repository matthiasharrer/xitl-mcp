// ADR-0038 (TC-244 unit part): the background page read after a tool sync.
// One read per page however many tools/syncs ask, none within the fresh
// window, a failure stores no hash; against a small in-memory stand-in for
// the Prisma calls (like toolSync.test.ts).
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fixedClock } from '../lib/clock.js';

type Page = { upstreamId: number; uri: string; contentHash: string | null; readAt: Date | null; lastReadFailed: boolean; csp: string | null };
const db = {
  upstream: { userId: 1, pausedAt: null as Date | null, toolsSyncedAt: new Date('2026-10-25T10:00:00Z') as Date | null },
  tools: [] as { uiResourceUri: string | null; lastSeenAt: Date }[],
  pages: [] as Page[],
};

const fakePrisma = {
  upstream: { findUnique: async () => db.upstream },
  knownTool: {
    findMany: async () => db.tools.filter((t) => t.uiResourceUri !== null).map((t) => ({ ...t })),
  },
  uiResource: {
    findMany: async ({ where }: { where: { uri: { in: string[] } } }) => db.pages.filter((p) => where.uri.in.includes(p.uri)).map((p) => ({ ...p })),
    findUnique: async ({ where }: { where: { upstreamId_uri: { uri: string } } }) => db.pages.find((p) => p.uri === where.upstreamId_uri.uri) ?? null,
    upsert: async ({ where, create, update }: { where: { upstreamId_uri: { uri: string } }; create: Partial<Page> & { upstreamId: number; uri: string }; update: Partial<Page> }) => {
      const hit = db.pages.find((p) => p.uri === where.upstreamId_uri.uri);
      if (hit) Object.assign(hit, update);
      else db.pages.push({ contentHash: null, readAt: null, lastReadFailed: false, csp: null, ...create });
    },
  },
};
vi.mock('../db.js', () => ({ prisma: fakePrisma }));
const { PageReader, PageReadFailed } = await import('./uiPages.js');
const { toolEvents } = await import('../lib/toolEvents.js');

const A = 'ui://fake/a.html';
const B = 'ui://fake/b.html';
const clock = fixedClock('2026-10-25T10:00:00Z');

beforeEach(() => {
  db.upstream = { userId: 1, pausedAt: null, toolsSyncedAt: clock.now() };
  db.tools = [
    { uiResourceUri: A, lastSeenAt: clock.now() },
    { uiResourceUri: A, lastSeenAt: clock.now() },
    { uiResourceUri: B, lastSeenAt: clock.now() },
  ];
  db.pages = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const okFetch = () =>
  vi.fn(async (_u: number, _user: number, uri: string) => ({ items: [], hash: `hash:${uri}`, csp: null }));

describe('PageReader (TC-244)', () => {
  test('one read per page (not per tool), concurrent syncs share it', async () => {
    const fetch = okFetch();
    const r = new PageReader({ clock, freshMs: 300_000, fetch });
    await Promise.all([r.run(3), r.run(3)]);
    expect(fetch.mock.calls.map((c) => c[2]).sort()).toEqual([A, B]);
    expect(db.pages.find((p) => p.uri === A)).toMatchObject({ contentHash: `hash:${A}`, lastReadFailed: false, readAt: clock.now() });
  });

  test('no second read within the fresh window; again after it', async () => {
    const fetch = okFetch();
    const r = new PageReader({ clock, freshMs: 300_000, fetch });
    await r.run(3);
    clock.advance(299_000);
    await r.run(3);
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.advance(2_000);
    await r.run(3);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test('a failed read stores no hash, marks the page unreadable, never throws', async () => {
    const r = new PageReader({ clock, freshMs: 300_000, fetch: vi.fn(async () => { throw new PageReadFailed(); }) });
    await expect(r.run(3)).resolves.toBeUndefined();
    expect(db.pages.find((p) => p.uri === A)).toMatchObject({ contentHash: null, lastReadFailed: true });
  });

  test('a failed re-read keeps the hash that was read', async () => {
    await new PageReader({ clock, freshMs: 1, fetch: okFetch() }).run(3);
    clock.advance(10);
    await new PageReader({ clock, freshMs: 1, fetch: vi.fn(async () => { throw new Error('boom'); }) }).run(3);
    expect(db.pages.find((p) => p.uri === A)).toMatchObject({ contentHash: `hash:${A}`, lastReadFailed: true });
  });

  test('vanished tools and paused upstreams are not read', async () => {
    const fetch = okFetch();
    db.tools[2]!.lastSeenAt = new Date(clock.now().getTime() - 1000);
    await new PageReader({ clock, freshMs: 300_000, fetch }).run(3);
    expect(fetch.mock.calls.map((c) => c[2])).toEqual([A]);
    db.upstream.pausedAt = clock.now();
    clock.advance(400_000);
    await new PageReader({ clock, freshMs: 300_000, fetch }).run(3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('pings Regeln when a page changed, not when it stayed the same', async () => {
    const seen: number[] = [];
    const off = toolEvents.on((e) => seen.push(e.userId));
    try {
      const fetch = okFetch();
      await new PageReader({ clock, freshMs: 1, fetch }).run(3);
      expect(seen).toEqual([1, 1]);
      clock.advance(10);
      await new PageReader({ clock, freshMs: 1, fetch }).run(3);
      expect(seen).toEqual([1, 1]);
    } finally {
      off();
    }
  });
});
