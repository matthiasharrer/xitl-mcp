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
import { pauseEvents } from '../lib/pauseEvents.js';
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
  /** Row id and the held call it was granted on (ADR-0029); optional so the
   * pure helpers can be fed plain test rows. */
  id?: number;
  anchorAuditId?: number | null;
  purpose?: string | null;
  purposeSource?: string | null;
}

/** The ALLOW pause that turned a call into ALLOW (ADR-0029): the AI check
 * compares with its anchor and ends exactly this row on a mismatch. */
export interface MatchedAllowPause {
  id: number;
  until: Date;
  /** null: granted before ADR-0029 shipped -> blind until it expires. */
  anchorAuditId: number | null;
  /** The human's "Wofür?" (ADR-0029 amendment); null/absent = none. */
  purpose?: string | null;
  /** TC-173: "typed" | "suggested" (display only); null/absent = none. */
  purposeSource?: string | null;
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
    allow: matchedAllow(live, toolName, readOnly),
    denyUntil: deny?.until ?? null,
    denyScope: deny?.scope ?? null,
  };
}

/** ADR-0029: WHICH allow pause covers the call, when several do: the one
 * with the latest `until` (the one `allowUntil` reports), ties broken by the
 * highest id (the newest grant). Deterministic, so the check always compares
 * with the same anchor and a mismatch ends that row. Rows without an id
 * (unit-test rows) are never matched. */
export function matchedAllow(live: EffectRow[], toolName: string, readOnly: boolean): MatchedAllowPause | null {
  let best: EffectRow | null = null;
  for (const r of live) {
    if (!isAllow(r) || !covers(r, toolName, readOnly) || typeof r.id !== 'number') continue;
    if (!best || r.until > best.until || (r.until.getTime() === best.until.getTime() && r.id > (best.id as number))) best = r;
  }
  return best
    ? {
        id: best.id as number,
        until: best.until,
        anchorAuditId: typeof best.anchorAuditId === 'number' ? best.anchorAuditId : null,
        ...(typeof best.purpose === 'string' && best.purpose.trim()
          ? { purpose: best.purpose, purposeSource: best.purposeSource === 'suggested' ? 'suggested' : 'typed' }
          : {}),
      }
    : null;
}

export interface PauseState {
  /** Latest live ALLOW pause covering the tool (ASK -> ALLOW). */
  allowUntil: Date | null;
  /** That pause's row (ADR-0029: anchor for the AI check), or null. */
  allow: MatchedAllowPause | null;
  /** Latest live DENY pause covering the tool, and its scope (for the text). */
  denyUntil: Date | null;
  denyScope: SnoozeScope | null;
}

async function liveRows(owner: SnoozeOwner, now: Date): Promise<EffectRow[]> {
  return prisma.snooze.findMany({
    where: { userId: owner.userId, upstreamId: owner.upstreamId, mcpClientId: owner.mcpClientId, until: { gt: now } },
    select: { id: true, scope: true, toolName: true, until: true, effect: true, anchorAuditId: true, purpose: true, purposeSource: true },
  });
}

/** The latest live ALLOW pause covering this tool for this client, or null.
 * Deny pauses are ignored here (see `livePauses`). */
export async function liveSnoozeUntil(owner: SnoozeOwner, toolName: string, readOnly: boolean, now: Date): Promise<Date | null> {
  return (await livePauses(owner, toolName, readOnly, now)).allowUntil;
}

/** A live deny pause (Sperre) covering a call, with what its purpose check
 * needs (ADR-0026 amendment). */
export interface CoveringDeny {
  id: number;
  anchorAuditId: number | null;
  purpose: string | null;
}

/** Every live non-ALLOW row covering the tool (any unrecognised effect counts
 * as a Sperre). Pure. Rows without an id are reported with id -1 (never a
 * purpose check: no anchor). */
export function coveringDenies(rows: EffectRow[], toolName: string, readOnly: boolean, now: Date): CoveringDeny[] {
  return rows
    .filter((r) => r.until.getTime() > now.getTime() && !isAllow(r) && covers(r, toolName, readOnly))
    .map((r) => ({
      id: typeof r.id === 'number' ? r.id : -1,
      anchorAuditId: typeof r.anchorAuditId === 'number' ? r.anchorAuditId : null,
      purpose: typeof r.purpose === 'string' && r.purpose.trim() ? r.purpose : null,
    }));
}

/** Both effects for one tools/call (ADR-0026): one query. `denies`: the
 * covering Sperren themselves (purpose check). */
export async function livePauses(owner: SnoozeOwner, toolName: string, readOnly: boolean, now: Date): Promise<PauseState & { denies: CoveringDeny[] }> {
  const rows = await liveRows(owner, now);
  return { ...pauseState(rows, toolName, readOnly, now), denies: coveringDenies(rows, toolName, readOnly, now) };
}

/** For tools/list: one query, then `untilFor(tool, readOnly)` per tool. Only
 * ALLOW pauses count (a deny-paused tool stays listed, ADR-0026). */
export async function liveSnoozesFor(owner: SnoozeOwner, now: Date): Promise<(toolName: string, readOnly: boolean) => Date | null> {
  const rows = await liveRows(owner, now);
  return (toolName, readOnly) => pauseState(rows, toolName, readOnly, now).allowUntil;
}

/** `anchorAuditId` (ADR-0029): the held call the pause is granted / the
 * Sperre is set on; `purpose`: the human's "Wofür?" (ADR-0029/0026
 * amendment). Both kept for either effect: a Sperre's purpose check needs
 * the blocked call. Returns the new row. */
export async function createSnooze(
  owner: SnoozeOwner,
  scope: SnoozeScope,
  toolName: string,
  until: Date,
  now: Date,
  effect: SnoozeEffect = 'ALLOW',
  anchorAuditId: number | null = null,
  purpose: string | null = null,
  /** TC-173: only an ALLOW pause can carry a suggested purpose. */
  purposeSource: 'typed' | 'suggested' | null = null,
): Promise<MatchedAllowPause> {
  const stored = purpose?.trim() || null;
  await prisma.snooze.deleteMany({ where: { userId: owner.userId, until: { lte: now } } });
  const row = await prisma.snooze.create({
    select: { id: true, until: true, anchorAuditId: true, purpose: true, purposeSource: true },
    data: {
      userId: owner.userId,
      upstreamId: owner.upstreamId,
      mcpClientId: owner.mcpClientId,
      scope,
      effect: effect === 'DENY' ? 'DENY' : 'ALLOW',
      toolName: scope === 'TOOL' ? toolName : null,
      until,
      createdAt: now,
      anchorAuditId,
      purpose: stored,
      purposeSource: stored ? (purposeSource === 'suggested' && effect === 'ALLOW' ? 'suggested' : 'typed') : null,
    },
  });
  // "Läuft gerade" (TC-181): the new entry appears live.
  pauseEvents.emit({ userId: owner.userId });
  return row;
}
