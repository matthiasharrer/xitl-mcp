// KnownTool bookkeeping (ADR-0004): every tools/list seen from an upstream
// (through the proxy or the UI's "Tools aktualisieren") is recorded, so the
// policy engine can tell a tool that was listed from one an agent is guessing,
// and a tool that is new from one the user has looked at.
import type { Tool } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { withUpstream, CONNECT_TIMEOUT_MS } from './connection.js';

/** Whether the FIRST tools/list ever seen for an upstream counts as
 * acknowledged. ADR-0004 says the new-tool rule is for tools "the upstream
 * added later"; treating the initial set as new too would make a default of
 * ALLOW mean ASK for everything until each tool was acknowledged by hand.
 * Set to false for the stricter reading (every tool starts as "Neu"). */
export const ACKNOWLEDGE_INITIAL_TOOLS = true;

const MAX_NAME = 128;
const MAX_DESCRIPTION = 10_000;

/** Upstream tools with a usable name, first occurrence of each name only. */
export function usableTools(tools: Tool[]): Tool[] {
  const seen = new Set<string>();
  return tools.filter((t) => {
    if (typeof t?.name !== 'string' || t.name.length === 0 || t.name.length > MAX_NAME || seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

/**
 * Upserts KnownTool rows for one upstream's current tool list.
 *
 * Rug pull (TC-36): when an ACKNOWLEDGED tool comes back with a different
 * description or annotations, its acknowledgement is withdrawn (-> ASK via the
 * "new-tool" rule, whatever the upstream default says) and `changedAt` is set
 * so the UI says "Geändert". Its snoozes are dropped too, so an explicit ASK
 * policy can't be bypassed by a snooze given for the old definition. An
 * explicit per-tool or per-client policy still wins over the re-flag (policy.ts
 * precedence), as for new tools.
 */
export async function syncKnownTools(upstreamId: number, tools: Tool[], clock: Clock = systemClock): Promise<void> {
  const now = clock.now();
  const existingRows = await prisma.knownTool.findMany({
    where: { upstreamId },
    select: { id: true, name: true, description: true, annotations: true, acknowledgedAt: true },
  });
  const byName = new Map(existingRows.map((r) => [r.name, r]));
  const acknowledgedAt = existingRows.length === 0 && ACKNOWLEDGE_INITIAL_TOOLS ? now : null;
  for (const t of usableTools(tools)) {
    const description = typeof t.description === 'string' ? t.description.slice(0, MAX_DESCRIPTION) : null;
    const annotations = t.annotations ? JSON.stringify(t.annotations) : null;
    const prev = byName.get(t.name);
    if (!prev) {
      await prisma.knownTool.upsert({
        where: { upstreamId_name: { upstreamId, name: t.name } },
        create: { upstreamId, name: t.name, description, annotations, firstSeenAt: now, lastSeenAt: now, acknowledgedAt },
        update: { description, annotations, lastSeenAt: now },
      });
      continue;
    }
    const changed = prev.description !== description || !sameAnnotations(prev.annotations, annotations);
    if (changed && prev.acknowledgedAt !== null) {
      // Conditional on the row still being acknowledged with the old text, so
      // a concurrent sync can't double-flag or undo a fresh acknowledgement.
      await prisma.knownTool.updateMany({
        where: { id: prev.id, acknowledgedAt: { not: null } },
        data: { description, annotations, lastSeenAt: now, acknowledgedAt: null, changedAt: now },
      });
      const owner = await prisma.upstream.findUnique({ where: { id: upstreamId }, select: { userId: true } });
      if (owner) await prisma.snooze.deleteMany({ where: { userId: owner.userId, upstreamId, toolName: t.name } });
      console.warn(`tools: upstream ${upstreamId}: tool definition changed, re-flagged for review`);
    } else {
      await prisma.knownTool.update({ where: { id: prev.id }, data: { description, annotations, lastSeenAt: now } });
    }
  }
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

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Fetches tools/list from the upstream (as `userId`) and records it. */
export async function refreshToolsFromUpstream(upstreamId: number, userId: number, clock: Clock = systemClock): Promise<Tool[]> {
  const tools = await withUpstream(
    upstreamId,
    userId,
    async ({ client }) => (await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS * 2 })).tools,
    { clock, timeoutMs: CONNECT_TIMEOUT_MS * 2 },
  );
  await syncKnownTools(upstreamId, tools, clock);
  return usableTools(tools);
}
