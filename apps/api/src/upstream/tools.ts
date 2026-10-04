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

/** Upserts KnownTool rows for one upstream's current tool list. */
export async function syncKnownTools(upstreamId: number, tools: Tool[], clock: Clock = systemClock): Promise<void> {
  const now = clock.now();
  const existing = await prisma.knownTool.count({ where: { upstreamId } });
  const acknowledgedAt = existing === 0 && ACKNOWLEDGE_INITIAL_TOOLS ? now : null;
  for (const t of usableTools(tools)) {
    const description = typeof t.description === 'string' ? t.description.slice(0, MAX_DESCRIPTION) : null;
    const annotations = t.annotations ? JSON.stringify(t.annotations) : null;
    await prisma.knownTool.upsert({
      where: { upstreamId_name: { upstreamId, name: t.name } },
      create: { upstreamId, name: t.name, description, annotations, firstSeenAt: now, lastSeenAt: now, acknowledgedAt },
      update: { description, annotations, lastSeenAt: now },
    });
  }
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
