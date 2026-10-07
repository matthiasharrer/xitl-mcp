// KnownTool bookkeeping (ADR-0004): every tools/list seen from an upstream
// (through the proxy or the UI's "Tools aktualisieren") is recorded, so the
// policy engine can tell a tool that was listed from one an agent is guessing,
// and a tool that is new from one the user has looked at.
//
// ADR-0034: every successful sync stamps `Upstream.toolsSyncedAt` (the same
// time as the listed tools' `lastSeenAt`, so a row seen before it vanished,
// upstream/freshness.ts) and, when it changed something the Regeln page shows,
// emits a payload-free `tools` event (lib/toolEvents.ts). ADR-0033: a paused
// upstream is never synced (withUpstream refuses to contact it first).
import type { Tool } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import { pauseEvents } from '../lib/pauseEvents.js';
import { toolEvents } from '../lib/toolEvents.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { withUpstream, CONNECT_TIMEOUT_MS } from './connection.js';
import { MAX_KNOWN_TOOLS_PER_UPSTREAM, MAX_UPSTREAM_TOOLS } from '../lib/limits.js';
import { scrubSecrets } from '../lib/proxyText.js';
import { canonical, isCosmetic, schemaText } from '../toolhint/defs.js';

/** Whether the FIRST tools/list ever seen for an upstream counts as
 * acknowledged. ADR-0004 says the new-tool rule is for tools "the upstream
 * added later"; treating the initial set as new too would make a default of
 * ALLOW mean ASK for everything until each tool was acknowledged by hand.
 * Set to false for the stricter reading (every tool starts as "Neu"). */
export const ACKNOWLEDGE_INITIAL_TOOLS = true;

const MAX_NAME = 128;
const MAX_DESCRIPTION = 10_000;

/** Upstream tools with a usable name, first occurrence of each name only, at
 * most MAX_UPSTREAM_TOOLS (TC-48: the rest are dropped, never recorded or
 * listed, so calling one is "unknown-tool"). */
export function usableTools(tools: Tool[], max: number = MAX_UPSTREAM_TOOLS): Tool[] {
  const seen = new Set<string>();
  const out: Tool[] = [];
  if (!Array.isArray(tools)) return out;
  for (const t of tools) {
    if (typeof t?.name !== 'string' || t.name.length === 0 || t.name.length > MAX_NAME || seen.has(t.name)) continue;
    if (out.length >= max) {
      if (!warnedAbout.has(tools)) {
        warnedAbout.add(tools);
        console.warn(`tools: upstream listed more than ${max} tools; the rest are ignored`);
      }
      break;
    }
    seen.add(t.name);
    out.push(t);
  }
  return out;
}
/** One log line per list, although sync and listing both filter it. */
const warnedAbout = new WeakSet<Tool[]>();

/** Called after every sync with the upstream id (ADR-0031: the background
 * Clef label of new/changed tools). Registered at boot (app.ts); listeners
 * must not throw and must not block (fire and forget). */
type SyncListener = (upstreamId: number) => void;
const syncListeners = new Set<SyncListener>();
export function onToolsSynced(l: SyncListener): () => void {
  syncListeners.add(l);
  return () => syncListeners.delete(l);
}

/**
 * Upserts KnownTool rows for one upstream's current tool list.
 *
 * Rug pull (TC-36): when a known tool comes back with a different description,
 * annotations or inputSchema (ADR-0031, canonical JSON), `changedAt` is set
 * and its acknowledgement withdrawn, so the UI says "Geändert" and the policy
 * engine treats it as changed: ASK ("changed-tool") whatever the upstream
 * default says, and an explicit tool- or client-level ALLOW (or AUTO) no
 * longer applies until the user acknowledges it (policy.ts; an explicit
 * ASK/DENY still does). Its snoozes are dropped too, so an explicit ASK can't
 * be bypassed by a snooze given for the old definition. This holds for tools
 * that were never acknowledged as well: a per-client ALLOW can be set on a
 * "Neu" tool without acknowledging it, and must not carry over to a
 * definition nobody has seen. The acknowledged definition is kept in prev*
 * (first change wins until acknowledged) for the Regeln diff and the hint.
 *
 * ADR-0031 exceptions, both without any model:
 * - First sight of an inputSchema on a row recorded before the column existed
 *   (NULL): stored silently, not a change.
 * - Cosmetic: only the description changed, and only in whitespace,
 *   punctuation or case (toolhint/defs.ts isCosmetic). Not a change: the new
 *   text is stored; on an acknowledged tool this is the auto-acknowledgement
 *   `auto-ack:cosmetic` (cosmeticAckAt, prev* = the text before). A tool
 *   still awaiting review stays exactly as it was (never acknowledged by it).
 */
export async function syncKnownTools(
  upstreamId: number,
  tools: Tool[],
  clock: Clock = systemClock,
  maxRows: number = MAX_KNOWN_TOOLS_PER_UPSTREAM,
): Promise<void> {
  const now = clock.now();
  const current = usableTools(tools);
  const existingRows = await prisma.knownTool.findMany({
    where: { upstreamId },
    select: { id: true, name: true, description: true, annotations: true, inputSchema: true, acknowledgedAt: true, changedAt: true },
  });
  const byName = new Map(existingRows.map((r) => [r.name, r]));
  const acknowledgedAt = existingRows.length === 0 && ACKNOWLEDGE_INITIAL_TOOLS ? now : null;
  // ADR-0034 (TC-206): did this sync change anything the Regeln page shows?
  let changedAny = false;
  for (const t of current) {
    const description = typeof t.description === 'string' ? t.description.slice(0, MAX_DESCRIPTION) : null;
    const annotations = t.annotations ? JSON.stringify(t.annotations) : null;
    const inputSchema = schemaText((t as { inputSchema?: unknown }).inputSchema);
    const prev = byName.get(t.name);
    if (!prev) {
      changedAny = true;
      await prisma.knownTool.upsert({
        where: { upstreamId_name: { upstreamId, name: t.name } },
        create: { upstreamId, name: t.name, description, annotations, inputSchema, firstSeenAt: now, lastSeenAt: now, acknowledgedAt },
        update: { description, annotations, inputSchema, lastSeenAt: now },
      });
      continue;
    }
    const prevSchema = prev.inputSchema ?? null;
    // NULL = recorded before ADR-0031: nothing to compare with (stored below).
    const schemaChanged = prevSchema !== null && prevSchema !== inputSchema;
    const descChanged = prev.description !== description;
    const annChanged = !sameAnnotations(prev.annotations, annotations);
    // Conditional on the row still holding the old definition, so a
    // concurrent sync that already handled it doesn't do it twice (and undo
    // an acknowledgement given for the new definition meanwhile).
    const unchangedSince = { id: prev.id, description: prev.description, annotations: prev.annotations, inputSchema: prevSchema };
    if (!descChanged && !annChanged && !schemaChanged) {
      await prisma.knownTool.update({ where: { id: prev.id }, data: { description, annotations, inputSchema, lastSeenAt: now } });
      continue;
    }
    changedAny = true;
    if (!annChanged && !schemaChanged && isCosmetic(prev.description, description)) {
      const acknowledged = prev.acknowledgedAt !== null && prev.changedAt === null;
      await prisma.knownTool.updateMany({
        where: unchangedSince,
        data: {
          description,
          inputSchema,
          lastSeenAt: now,
          ...(acknowledged
            ? { prevDescription: prev.description, prevAnnotations: prev.annotations, prevInputSchema: prevSchema ?? inputSchema, cosmeticAckAt: now }
            : {}),
        },
      });
      console.log(`tools: upstream ${upstreamId}: cosmetic description change${acknowledged ? ' auto-acknowledged (auto-ack:cosmetic)' : ''}`);
      continue;
    }
    // A real change. prev* keeps the acknowledged definition: set only when
    // the tool wasn't already awaiting review as changed.
    const keepPrev = prev.changedAt !== null;
    await prisma.knownTool.updateMany({
      where: unchangedSince,
      data: {
        description,
        annotations,
        inputSchema,
        lastSeenAt: now,
        acknowledgedAt: null,
        changedAt: now,
        cosmeticAckAt: null,
        ...(keepPrev ? {} : { prevDescription: prev.description, prevAnnotations: prev.annotations, prevInputSchema: prevSchema }),
      },
    });
    const owner = await prisma.upstream.findUnique({ where: { id: upstreamId }, select: { userId: true } });
    if (owner) {
      const gone = await prisma.snooze.deleteMany({ where: { userId: owner.userId, upstreamId, toolName: t.name } });
      if (gone.count > 0) pauseEvents.emit({ userId: owner.userId });
    }
    console.warn(`tools: upstream ${upstreamId}: tool definition changed, re-flagged for review`);
  }
  if (await pruneStaleTools(upstreamId, new Set(current.map((t) => t.name)), now, maxRows)) changedAny = true;
  // Every listed tool counts as seen now, also where a conditional write above
  // found the row already handled by a concurrent sync (the vanished rule
  // compares lastSeenAt with toolsSyncedAt).
  await prisma.knownTool.updateMany({
    where: { upstreamId, name: { in: current.map((t) => t.name) }, lastSeenAt: { lt: now } },
    data: { lastSeenAt: now },
  });
  // ADR-0034: the list is fresh as of `now`. Only forwards: a slower sync that
  // started earlier must not make the stamp older (its `now` is older).
  await prisma.upstream.updateMany({
    where: { id: upstreamId, OR: [{ toolsSyncedAt: null }, { toolsSyncedAt: { lt: now } }] },
    data: { toolsSyncedAt: now },
  });
  if (changedAny) {
    const owner = await prisma.upstream.findUnique({ where: { id: upstreamId }, select: { userId: true } });
    if (owner) toolEvents.emit({ userId: owner.userId });
  }
  for (const l of [...syncListeners]) {
    try {
      l(upstreamId);
    } catch (e) {
      console.warn(`tools: sync listener failed: ${e instanceof Error ? e.name : 'unknown'}`);
    }
  }
}

/**
 * Which KnownTool rows to delete so at most `maxRows` remain: only rows NOT in
 * the current list, oldest `lastSeenAt` first (ties: lower id first). Rows in
 * the current list are never chosen, even if they alone exceed the cap. Pure;
 * exported for the unit test (TC-89).
 */
export function staleToolsToPrune(
  rows: { id: number; name: string; lastSeenAt: Date }[],
  currentNames: ReadonlySet<string>,
  maxRows: number,
): number[] {
  const excess = rows.length - Math.max(0, maxRows);
  if (excess <= 0) return [];
  return rows
    .filter((r) => !currentNames.has(r.name))
    .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime() || a.id - b.id)
    .slice(0, excess)
    .map((r) => r.id);
}

/** TC-89: an upstream that rotates tool names must not grow KnownTool without
 * bound. A deleted row takes its per-client rules with it (cascade) and its
 * TOOL pauses; if the tool comes back it is "Neu" (never acknowledged), and
 * until then a call to it is "unknown-tool" DENY. */
async function pruneStaleTools(upstreamId: number, currentNames: ReadonlySet<string>, now: Date, maxRows: number): Promise<boolean> {
  if ((await prisma.knownTool.count({ where: { upstreamId } })) <= maxRows) return false;
  const rows = await prisma.knownTool.findMany({ where: { upstreamId }, select: { id: true, name: true, lastSeenAt: true } });
  const ids = staleToolsToPrune(rows, currentNames, maxRows);
  if (ids.length === 0) return false;
  const idSet = new Set(ids);
  const doomed = rows.filter((r) => idSet.has(r.id)).map((r) => r.name);
  // `lastSeenAt < now`: a concurrent sync that has just seen one of these
  // tools again keeps it.
  const res = await prisma.knownTool.deleteMany({ where: { upstreamId, id: { in: ids }, lastSeenAt: { lt: now } } });
  const gone = await prisma.snooze.deleteMany({ where: { upstreamId, scope: 'TOOL', toolName: { in: doomed } } });
  if (gone.count > 0) {
    const owner = await prisma.upstream.findUnique({ where: { id: upstreamId }, select: { userId: true } });
    if (owner) pauseEvents.emit({ userId: owner.userId });
  }
  console.warn(`tools: upstream ${upstreamId}: ${res.count} stale tool row(s) removed (cap ${maxRows})`);
  return res.count > 0;
}

/** Annotations compared as data (key order doesn't count as a change). */
function sameAnnotations(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch {
    return false;
  }
}

/** Fetches tools/list from the upstream (as `userId`) and records it. */
export async function refreshToolsFromUpstream(upstreamId: number, userId: number, clock: Clock = systemClock): Promise<Tool[]> {
  const tools = await withUpstream(
    upstreamId,
    userId,
    async ({ client, secrets }) => scrubSecrets((await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS * 2 })).tools, secrets()),
    { clock, timeoutMs: CONNECT_TIMEOUT_MS * 2 },
  );
  await syncKnownTools(upstreamId, tools, clock);
  return usableTools(tools);
}
