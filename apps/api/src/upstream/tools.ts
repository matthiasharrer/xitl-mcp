// KnownTool bookkeeping (ADR-0004): every tools/list seen from an upstream
// (through the proxy or the UI's "Tools aktualisieren") is recorded, so the
// policy engine can tell a tool that was listed from one an agent is guessing,
// and a tool that is new from one the user has looked at.
import type { Tool } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { withUpstream, CONNECT_TIMEOUT_MS } from './connection.js';
import { MAX_UPSTREAM_TOOLS } from '../lib/limits.js';
import { scrubSecrets } from '../lib/proxyText.js';

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

/**
 * Upserts KnownTool rows for one upstream's current tool list.
 *
 * Rug pull (TC-36): when a known tool comes back with a different description
 * or annotations, `changedAt` is set and its acknowledgement withdrawn, so the
 * UI says "Geändert" and the policy engine treats it as changed: ASK
 * ("changed-tool") whatever the upstream default says, and an explicit
 * tool- or client-level ALLOW no longer applies until the user acknowledges it
 * (policy.ts; an explicit ASK/DENY still does). Its snoozes are dropped too,
 * so an explicit ASK can't be bypassed by a snooze given for the old
 * definition. This holds for tools that were never acknowledged as well: a
 * per-client ALLOW can be set on a "Neu" tool without acknowledging it, and
 * must not carry over to a definition nobody has seen.
 */
export async function syncKnownTools(upstreamId: number, tools: Tool[], clock: Clock = systemClock): Promise<void> {
  const now = clock.now();
  const existingRows = await prisma.knownTool.findMany({
    where: { upstreamId },
    select: { id: true, name: true, description: true, annotations: true },
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
    if (changed) {
      // Conditional on the row still holding the old definition, so a
      // concurrent sync that already flagged it doesn't flag it again (and
      // undo an acknowledgement given for the new definition meanwhile).
      await prisma.knownTool.updateMany({
        where: { id: prev.id, description: prev.description, annotations: prev.annotations },
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
    async ({ client, secrets }) => scrubSecrets((await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS * 2 })).tools, secrets()),
    { clock, timeoutMs: CONNECT_TIMEOUT_MS * 2 },
  );
  await syncKnownTools(upstreamId, tools, clock);
  return usableTools(tools);
}
