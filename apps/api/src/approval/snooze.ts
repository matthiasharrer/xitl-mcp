// Snooze rows (ADR-0004, TC-30, TC-76): "don't ask again for this client
// until", for one tool, for every read-only tool of the upstream, or for every
// tool of the upstream. Every query is scoped by the owning user. Expired rows
// are harmless (the policy compares `until` with the Clock) and are pruned
// opportunistically.
//
// Two effects (ADR-0026): an ALLOW pause only ever turns ASK into ALLOW and
// never applies to a new or changed tool (policy.ts); a DENY pause refuses
// every covered call ("snooze-deny", right after unknown-tool). Any effect
// other than exactly 'ALLOW' is a DENY (fail closed). "read-only" is the tool's STORED annotations
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

/** ADR-0026. Only exactly 'ALLOW' is an allow pause; anything else is DENY. */
export type SnoozeEffect = 'ALLOW' | 'DENY';

interface Row {
  scope: SnoozeScope;
  toolName: string | null;
  until: Date;
}

interface EffectRow extends Row {
  /** Raw DB text: read through `isAllow`, never compared to 'DENY'. */
  effect: string;
}

/** Fail closed: a row is an allow pause only if its effect is exactly 'ALLOW'. */
export function isAllow(row: Pick<EffectRow, 'effect'>): boolean {
  return row.effect === 'ALLOW';
}

/** Does this snooze row cover the tool? Pure; exported for the unit test. */
export function covers(row: Pick<Row, 'scope' | 'toolName'>, toolName: string, readOnly: boolean): boolean {
  if (row.scope === 'UPSTREAM') return true;
  if (row.scope === 'READONLY') return readOnly;
  return row.scope === 'TOOL' && row.toolName === toolName;
}

/** The OTHER held calls a pause just set on `origin` covers (same user,
 * client and upstream, scope as `covers`). An ALLOW pause takes only calls
 * that could be paused themselves (`snoozable`: never new or changed tools,
 * like policy.ts); a DENY pause takes every covered call (it only tightens).
 * Pure; the caller settles them. */
export function heldCoveredBy<C extends { id: string; userId: number; mcpClientId: number; upstreamId: number; toolName: string; readOnly: boolean; snoozable: boolean }>(
  origin: C,
  held: C[],
  scope: SnoozeScope,
  effect: SnoozeEffect,
): C[] {
  const row = { scope, toolName: scope === 'TOOL' ? origin.toolName : null };
  return held.filter(
    (c) =>
      c.id !== origin.id &&
      c.userId === origin.userId &&
      c.mcpClientId === origin.mcpClientId &&
      c.upstreamId === origin.upstreamId &&
      (effect === 'DENY' || c.snoozable) &&
      covers(row, c.toolName, c.readOnly),
  );
}

/** Latest `until` of the rows covering the tool, or null. */
export function latestCovering(rows: Row[], toolName: string, readOnly: boolean): Date | null {
  let best: Date | null = null;
  for (const r of rows) if (covers(r, toolName, readOnly) && (!best || r.until > best)) best = r.until;
  return best;
}

/** The live pauses covering one tool, split by effect. Pure (TC-121's
 * matching half). `rows` are the owner's live rows; `until` is re-checked. A
 * DENY row (or one with any unrecognised effect) never counts as ALLOW. */
export function pauseState(rows: EffectRow[], toolName: string, readOnly: boolean, now: Date): PauseState {
  const live = rows.filter((r) => r.until.getTime() > now.getTime());
  let deny: EffectRow | null = null;
  for (const r of live) if (!isAllow(r) && covers(r, toolName, readOnly) && (!deny || r.until > deny.until)) deny = r;
  return {
    allowUntil: latestCovering(live.filter(isAllow), toolName, readOnly),
    denyUntil: deny?.until ?? null,
    denyScope: deny?.scope ?? null,
  };
}

export interface PauseState {
  /** Latest live ALLOW pause covering the tool (ASK -> ALLOW). */
  allowUntil: Date | null;
  /** Latest live DENY pause covering the tool, and its scope (for the text). */
  denyUntil: Date | null;
  denyScope: SnoozeScope | null;
}

async function liveRows(owner: SnoozeOwner, now: Date): Promise<EffectRow[]> {
  return prisma.snooze.findMany({
    where: { userId: owner.userId, upstreamId: owner.upstreamId, mcpClientId: owner.mcpClientId, until: { gt: now } },
    select: { scope: true, toolName: true, until: true, effect: true },
  });
}

/** The latest live ALLOW pause covering this tool for this client, or null.
 * Deny pauses are ignored here (see `livePauses`). */
export async function liveSnoozeUntil(owner: SnoozeOwner, toolName: string, readOnly: boolean, now: Date): Promise<Date | null> {
  return (await livePauses(owner, toolName, readOnly, now)).allowUntil;
}

/** Both effects for one tools/call (ADR-0026): one query. */
export async function livePauses(owner: SnoozeOwner, toolName: string, readOnly: boolean, now: Date): Promise<PauseState> {
  return pauseState(await liveRows(owner, now), toolName, readOnly, now);
}

/** For tools/list: one query, then `untilFor(tool, readOnly)` per tool. Only
 * ALLOW pauses count (a deny-paused tool stays listed, ADR-0026). */
export async function liveSnoozesFor(owner: SnoozeOwner, now: Date): Promise<(toolName: string, readOnly: boolean) => Date | null> {
  const rows = await liveRows(owner, now);
  return (toolName, readOnly) => pauseState(rows, toolName, readOnly, now).allowUntil;
}

export async function createSnooze(
  owner: SnoozeOwner,
  scope: SnoozeScope,
  toolName: string,
  until: Date,
  now: Date,
  effect: SnoozeEffect = 'ALLOW',
): Promise<void> {
  await prisma.snooze.deleteMany({ where: { userId: owner.userId, until: { lte: now } } });
  await prisma.snooze.create({
    data: {
      userId: owner.userId,
      upstreamId: owner.upstreamId,
      mcpClientId: owner.mcpClientId,
      scope,
      effect: effect === 'DENY' ? 'DENY' : 'ALLOW',
      toolName: scope === 'TOOL' ? toolName : null,
      until,
      createdAt: now,
    },
  });
}
