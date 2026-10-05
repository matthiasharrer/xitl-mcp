// Snooze rows (ADR-0004, TC-30, TC-76): "don't ask again for this client
// until", for one tool, for every read-only tool of the upstream, or for every
// tool of the upstream. Every query is scoped by the owning user. Expired rows
// are harmless (the policy compares `until` with the Clock) and are pruned
// opportunistically.
//
// A snooze only ever turns ASK into ALLOW and never applies to a new or
// changed tool (policy.ts); "read-only" is the tool's STORED annotations
// (KnownTool), and an annotation change marks the tool changed, so an upstream
// cannot relabel a tool to slip under a READONLY snooze.
import { prisma } from '../db.js';
import { toolHint } from '../lib/proxyText.js';

export type SnoozeScope = 'TOOL' | 'READONLY' | 'UPSTREAM';

/** Who and where: one client on one upstream of one user. */
export interface SnoozeOwner {
  userId: number;
  upstreamId: number;
  mcpClientId: number;
}

/** Is a tool read-only by its stored annotations (KnownTool.annotations JSON)? */
export function isReadOnly(annotationsJson: string | null | undefined): boolean {
  if (!annotationsJson) return false;
  try {
    return toolHint(JSON.parse(annotationsJson)) === 'read';
  } catch {
    return false;
  }
}

interface Row {
  scope: SnoozeScope;
  toolName: string | null;
  until: Date;
}

/** Does this snooze row cover the tool? Pure; exported for the unit test. */
export function covers(row: Pick<Row, 'scope' | 'toolName'>, toolName: string, readOnly: boolean): boolean {
  if (row.scope === 'UPSTREAM') return true;
  if (row.scope === 'READONLY') return readOnly;
  return row.scope === 'TOOL' && row.toolName === toolName;
}

/** Latest `until` of the rows covering the tool, or null. */
export function latestCovering(rows: Row[], toolName: string, readOnly: boolean): Date | null {
  let best: Date | null = null;
  for (const r of rows) if (covers(r, toolName, readOnly) && (!best || r.until > best)) best = r.until;
  return best;
}

async function liveRows(owner: SnoozeOwner, now: Date): Promise<Row[]> {
  return prisma.snooze.findMany({
    where: { ...owner, until: { gt: now } },
    select: { scope: true, toolName: true, until: true },
  });
}

/** The latest live snooze covering this tool for this client, or null. */
export async function liveSnoozeUntil(owner: SnoozeOwner, toolName: string, readOnly: boolean, now: Date): Promise<Date | null> {
  return latestCovering(await liveRows(owner, now), toolName, readOnly);
}

/** For tools/list: one query, then `untilFor(tool, readOnly)` per tool. */
export async function liveSnoozesFor(owner: SnoozeOwner, now: Date): Promise<(toolName: string, readOnly: boolean) => Date | null> {
  const rows = await liveRows(owner, now);
  return (toolName, readOnly) => latestCovering(rows, toolName, readOnly);
}

export async function createSnooze(owner: SnoozeOwner, scope: SnoozeScope, toolName: string, until: Date, now: Date): Promise<void> {
  await prisma.snooze.deleteMany({ where: { userId: owner.userId, until: { lte: now } } });
  await prisma.snooze.create({ data: { ...owner, scope, toolName: scope === 'TOOL' ? toolName : null, until, createdAt: now } });
}
