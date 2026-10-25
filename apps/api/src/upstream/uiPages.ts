// MCP Apps pages (ADR-0038 + amendment 2026-10-25): reading a `ui://` page
// from an upstream and recording what was read (UiResource). Three callers:
// - the background read after every tool sync (PageReader, wired to
//   onToolsSynced in app.ts): each distinct view URI of the upstream's
//   current tools, at most one read in flight per (upstream, URI), skipped
//   when the last attempt is younger than TOOLS_FRESH_MS; never awaited by
//   the list, never throws out. It records contentHash (so "Neu" / "Geändert"
//   shows in Regeln and a changed page is stripped from the next tools/list)
//   and pings open Regeln pages (toolEvents) when that changed anything.
// - the tap in Regeln (routes/upstreamTools.ts): reads now and acknowledges
//   exactly that hash (acknowledgePage).
// - a host's resources/read (mcp/server.ts): reads now; a hash other than
//   the acknowledged one is recorded (recordPage) and refused.
// Every read is scrubbed of the upstream's credentials BEFORE it is
// validated, hashed or served (ADR-0007, like tool output), and validated by
// uiViews.validatePage. A JSON-RPC error from the upstream (e.g. it serves
// no resources) is a failed read, not a failed contact (no Störung).
import { ProtocolError } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { scrubSecrets } from '../lib/proxyText.js';
import { toolEvents } from '../lib/toolEvents.js';
import { CONNECT_TIMEOUT_MS, withUpstream } from './connection.js';
import { SingleFlight, toolsFreshFromEnv, toolsStale, vanished } from './freshness.js';
import { errorTag } from './oauthClient.js';
import { pageCsp, pageHash, validatePage, type PageCsp, type PageItem } from './uiViews.js';

/** The upstream's answer was no servable page (or a JSON-RPC error). */
export class PageReadFailed extends Error {
  override name = 'PageReadFailed';
}

export interface FetchedPage {
  items: PageItem[];
  hash: string;
  csp: PageCsp | null;
}

const READ_TIMEOUT_MS = CONNECT_TIMEOUT_MS * 2;
const NO_PAGE = Symbol('no page');

/** Reads one page from the upstream now (as `userId`): scrubbed, validated,
 * hashed. Throws PageReadFailed for an unusable answer; the connection
 * errors of withUpstream (UpstreamPaused, …) pass through. */
export async function fetchPage(upstreamId: number, userId: number, uri: string, clock: Clock = systemClock): Promise<FetchedPage> {
  const raw = await withUpstream(
    upstreamId,
    userId,
    async ({ client, secrets }) => {
      try {
        return scrubSecrets(await client.readResource({ uri }, { timeout: READ_TIMEOUT_MS, cacheMode: 'bypass' }), secrets());
      } catch (e) {
        // The upstream answered with an error (or something the SDK rejects):
        // the contact worked, the page didn't.
        if (e instanceof ProtocolError) return NO_PAGE;
        throw e;
      }
    },
    { clock, timeoutMs: READ_TIMEOUT_MS },
  );
  const items = raw === NO_PAGE ? null : validatePage(raw, uri);
  if (!items) throw new PageReadFailed();
  return { items, hash: pageHash(items), csp: pageCsp(items) };
}

/** Records a read (null = failed) of `uri`: contentHash/csp on success,
 * lastReadFailed on failure (a failure keeps the last hash: nothing that
 * was shown changes, nothing new is shown). Pings the owner's Regeln pages
 * when the state changed. Returns whether it did. */
export async function recordPage(upstreamId: number, uri: string, page: FetchedPage | null, now: Date): Promise<boolean> {
  const before = await prisma.uiResource.findUnique({
    where: { upstreamId_uri: { upstreamId, uri } },
    select: { contentHash: true, lastReadFailed: true },
  });
  const data = page
    ? { contentHash: page.hash, csp: page.csp ? JSON.stringify(page.csp) : null, readAt: now, lastReadFailed: false }
    : { readAt: now, lastReadFailed: true };
  await prisma.uiResource.upsert({
    where: { upstreamId_uri: { upstreamId, uri } },
    create: { upstreamId, uri, ...data },
    update: data,
  });
  const changed = page ? before?.contentHash !== page.hash || before?.lastReadFailed === true : before?.lastReadFailed !== true;
  if (changed) {
    const owner = await prisma.upstream.findUnique({ where: { id: upstreamId }, select: { userId: true } });
    if (owner) toolEvents.emit({ userId: owner.userId });
  }
  return changed;
}

/** The tap ("Oberfläche anzeigen" / "Neue Version anzeigen"): reads the page
 * now and acknowledges exactly that hash. Throws when the read fails
 * (nothing is changed then). */
export async function acknowledgePage(upstreamId: number, userId: number, uri: string, clock: Clock = systemClock): Promise<FetchedPage> {
  const page = await fetchPage(upstreamId, userId, uri, clock);
  const now = clock.now();
  const data = {
    contentHash: page.hash,
    acknowledgedHash: page.hash,
    acknowledgedAt: now,
    csp: page.csp ? JSON.stringify(page.csp) : null,
    readAt: now,
    lastReadFailed: false,
  };
  await prisma.uiResource.upsert({ where: { upstreamId_uri: { upstreamId, uri } }, create: { upstreamId, uri, ...data }, update: data });
  return page;
}

type Fetcher = typeof fetchPage;

/** The background read after a tool sync (see the header). */
export class PageReader {
  private flight = new SingleFlight<string, void>();
  private clock: Clock;
  private freshMs: number;
  private fetch: Fetcher;

  constructor(opts: { clock?: Clock; freshMs?: number; fetch?: Fetcher } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.freshMs = opts.freshMs ?? toolsFreshFromEnv(process.env.TOOLS_FRESH_MS);
    this.fetch = opts.fetch ?? fetchPage;
  }

  /** Starts the reads this upstream's current tools need; resolves when
   * they are done (tests). Never rejects. */
  async run(upstreamId: number): Promise<void> {
    try {
      const up = await prisma.upstream.findUnique({ where: { id: upstreamId }, select: { userId: true, pausedAt: true, toolsSyncedAt: true } });
      if (!up || up.pausedAt !== null) return;
      const rows = await prisma.knownTool.findMany({
        where: { upstreamId, uiResourceUri: { not: null } },
        select: { uiResourceUri: true, lastSeenAt: true },
      });
      const uris = [...new Set(rows.filter((r) => !vanished(r.lastSeenAt, up.toolsSyncedAt)).map((r) => r.uiResourceUri!))];
      if (uris.length === 0) return;
      const known = await prisma.uiResource.findMany({ where: { upstreamId, uri: { in: uris } }, select: { uri: true, readAt: true } });
      const readAt = new Map(known.map((k) => [k.uri, k.readAt]));
      const now = this.clock.now();
      const due = uris.filter((u) => {
        const at = readAt.get(u);
        return !at || toolsStale(at, now, this.freshMs);
      });
      await Promise.all(due.map((uri) => this.flight.run(`${upstreamId}\n${uri}`, () => this.readOne(upstreamId, up.userId, uri)).catch(() => undefined)));
    } catch (e) {
      console.warn(`ui: upstream ${upstreamId}: background page read failed: ${errorTag(e)}`);
    }
  }

  private async readOne(upstreamId: number, userId: number, uri: string): Promise<void> {
    let page: FetchedPage | null = null;
    try {
      page = await this.fetch(upstreamId, userId, uri, this.clock);
    } catch (e) {
      // Never the URI's content or the error text (may carry upstream data).
      console.warn(`ui: upstream ${upstreamId}: page read failed: ${errorTag(e)}`);
    }
    try {
      await recordPage(upstreamId, uri, page, this.clock.now());
    } catch (e) {
      console.warn(`ui: upstream ${upstreamId}: page state not stored: ${errorTag(e)}`);
    }
  }
}

export const pageReader = new PageReader();
