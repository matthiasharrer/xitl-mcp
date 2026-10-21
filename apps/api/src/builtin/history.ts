// The Verlauf as the built-in `xitl` upstream exposes it (ADR-0037).
//
// Three things live here, all pure except `loadEntry`:
//   - parseHistoryArgs: the strict argument parser of list_history. Anything it
//     doesn't recognise is an ERROR (German + English), never "all rows": an
//     agent that mistypes a filter must not believe it got a filtered list.
//   - historyWhere: the parsed filters as a Prisma `where`, ALWAYS with the
//     `userId` the server was built for (TC-232).
//   - the serializers: whitelists. They build objects field by field and the
//     queries `select` only what they emit, so a column added to AuditEntry
//     later can never leave by accident. Never emitted: result text, intent
//     prompt / answer, diagnostics, anything of the upstream's configuration.
import { prisma } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { berlinDayStart, berlinOffsetMs, nextBerlinDay } from '../approval/budget.js';
import { FORWARDED_OUTCOMES } from '../pausecheck/gate.js';
import { PAUSE_CHECK_MAX_SINCE } from '../lib/limits.js';
import { buildState, type CheckCall } from '../pausecheck/prompt.js';
import { SLUG_PATTERN } from '../lib/slugs.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
const MAX_TOOL_FILTER = 200;

export const STATUSES = ['forwarded', 'denied', 'pending', 'timed_out', 'upstream_error'] as const;
export type StatusFilter = (typeof STATUSES)[number];
const OUTCOME_OF: Record<StatusFilter, 'FORWARDED' | 'DENIED' | 'PENDING' | 'TIMED_OUT' | 'UPSTREAM_ERROR'> = {
  forwarded: 'FORWARDED',
  denied: 'DENIED',
  pending: 'PENDING',
  timed_out: 'TIMED_OUT',
  upstream_error: 'UPSTREAM_ERROR',
};
export const PAUSE_CHECKS = ['match', 'mismatch', 'error'] as const;
export type PauseCheckFilter = (typeof PAUSE_CHECKS)[number];

/** One end of a time filter: a whole Berlin day, or an instant. */
export type TimeBound = { kind: 'day'; ymd: string } | { kind: 'instant'; at: Date };

export interface HistoryFilter {
  upstream?: string;
  tool?: string;
  status?: StatusFilter;
  pauseCheck?: PauseCheckFilter;
  from?: TimeBound;
  to?: TimeBound;
  limit: number;
  before?: number;
}

export type Parsed = { ok: true; filter: HistoryFilter } | { ok: false; message: string };

const bad = (de: string, en: string): Parsed => ({ ok: false, message: `${de} / ${en}` });

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `YYYY-MM-DD` (a Berlin day) or an ISO date-time WITH offset; else null. */
export function parseBound(raw: unknown): TimeBound | null {
  if (typeof raw !== 'string') return null;
  if (berlinDayStart(raw) !== null) return { kind: 'day', ymd: raw };
  if (ISO_INSTANT.test(raw)) {
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return { kind: 'instant', at };
  }
  return null;
}

const ALLOWED_KEYS = ['upstream', 'tool', 'status', 'pause_check', 'from', 'to', 'limit', 'before'];

export function parseHistoryArgs(args: unknown): Parsed {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return bad('Die Argumente müssen ein Objekt sein.', 'The arguments must be an object.');
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (!ALLOWED_KEYS.includes(k)) {
      return bad(`Unbekanntes Argument „${k.slice(0, 40)}“. Erlaubt: ${ALLOWED_KEYS.join(', ')}.`, `Unknown argument "${k.slice(0, 40)}". Allowed: ${ALLOWED_KEYS.join(', ')}.`);
    }
  }
  const filter: HistoryFilter = { limit: DEFAULT_LIMIT };

  // A value that is present must be valid: `undefined` alone means "absent"
  // (JSON null is not accepted; it would silently mean "no filter").
  if (a.upstream !== undefined) {
    if (typeof a.upstream !== 'string' || !SLUG_PATTERN.test(a.upstream)) return bad('upstream muss ein Upstream-Kürzel sein (z. B. "haushalt").', 'upstream must be an upstream slug (e.g. "haushalt").');
    filter.upstream = a.upstream;
  }
  if (a.tool !== undefined) {
    if (typeof a.tool !== 'string' || a.tool === '' || a.tool.length > MAX_TOOL_FILTER) return bad('tool muss ein exakter Tool-Name sein.', 'tool must be an exact tool name.');
    filter.tool = a.tool;
  }
  if (a.status !== undefined) {
    if (typeof a.status !== 'string' || !(STATUSES as readonly string[]).includes(a.status)) return bad(`status muss einer von ${STATUSES.join(', ')} sein.`, `status must be one of ${STATUSES.join(', ')}.`);
    filter.status = a.status as StatusFilter;
  }
  if (a.pause_check !== undefined) {
    if (typeof a.pause_check !== 'string' || !(PAUSE_CHECKS as readonly string[]).includes(a.pause_check)) return bad(`pause_check muss einer von ${PAUSE_CHECKS.join(', ')} sein.`, `pause_check must be one of ${PAUSE_CHECKS.join(', ')}.`);
    filter.pauseCheck = a.pause_check as PauseCheckFilter;
  }
  for (const key of ['from', 'to'] as const) {
    if (a[key] === undefined) continue;
    const b = parseBound(a[key]);
    if (!b) return bad(`${key} muss ein Datum JJJJ-MM-TT (Berliner Tag) oder ein ISO-Zeitpunkt mit Zeitzone sein.`, `${key} must be a date YYYY-MM-DD (a Berlin day) or an ISO date-time with offset.`);
    filter[key] = b;
  }
  if (a.limit !== undefined) {
    if (typeof a.limit !== 'number' || !Number.isInteger(a.limit) || a.limit < 1 || a.limit > MAX_LIMIT) return bad(`limit muss eine ganze Zahl von 1 bis ${MAX_LIMIT} sein.`, `limit must be an integer from 1 to ${MAX_LIMIT}.`);
    filter.limit = a.limit;
  }
  if (a.before !== undefined) {
    if (typeof a.before !== 'number' || !Number.isInteger(a.before) || a.before < 1 || a.before > 2_000_000_000) return bad('before muss eine Eintrags-Id (positive ganze Zahl) sein, am besten nextBefore.', 'before must be an entry id (positive integer), ideally nextBefore.');
    filter.before = a.before;
  }
  return { ok: true, filter };
}

/** The filters as a `where`, scoped to `userId` first. Each filter narrows
 * (AND); none ever widens. */
export function historyWhere(userId: number, f: HistoryFilter): Prisma.AuditEntryWhereInput {
  const and: Prisma.AuditEntryWhereInput[] = [];
  if (f.upstream !== undefined) and.push({ upstream: { is: { slug: f.upstream, userId } } });
  if (f.tool !== undefined) and.push({ toolName: f.tool });
  if (f.status !== undefined) and.push({ outcome: OUTCOME_OF[f.status] });
  if (f.pauseCheck === 'match') and.push({ pauseCheckChoice: 'gleich' });
  if (f.pauseCheck === 'mismatch') and.push({ pauseCheckChoice: { in: ['richtungswechsel', 'ausweitung'] } });
  if (f.pauseCheck === 'error') and.push({ decisionPath: { startsWith: 'snooze-ki-error' } });
  if (f.from) {
    // A day starts at its Berlin midnight; an instant is taken as is.
    const at = f.from.kind === 'day' ? berlinDayStart(f.from.ymd) : f.from.at;
    if (at) and.push({ receivedAt: { gte: at } });
  }
  if (f.to) {
    if (f.to.kind === 'day') {
      // Inclusive: up to (not including) the next Berlin midnight.
      const next = nextBerlinDay(f.to.ymd);
      const end = next ? berlinDayStart(next) : null;
      if (end) and.push({ receivedAt: { lt: end } });
    } else {
      and.push({ receivedAt: { lte: f.to.at } });
    }
  }
  if (f.before !== undefined) and.push({ id: { lt: f.before } });
  return { userId, AND: and };
}

/** Europe/Berlin local time with its offset, e.g. 2026-10-21T14:03:05+02:00. */
export function berlinIso(d: Date): string {
  const off = berlinOffsetMs(d);
  const local = new Date(d.getTime() + off).toISOString().slice(0, 19);
  const mins = Math.round(off / 60_000);
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The pause check of a row, as a label: match / mismatch / error, or null. */
export function pauseCheckResult(r: { decisionPath: string; pauseCheckChoice: string | null }): 'match' | 'mismatch' | 'error' | null {
  if (r.decisionPath.startsWith('snooze-ki-error')) return 'error';
  if (r.pauseCheckChoice === 'gleich') return 'match';
  if (r.pauseCheckChoice === 'richtungswechsel' || r.pauseCheckChoice === 'ausweitung') return 'mismatch';
  return null;
}

// ---- list ---------------------------------------------------------------

export const listSelect = {
  id: true,
  receivedAt: true,
  toolName: true,
  outcome: true,
  policy: true,
  decisionPath: true,
  pauseCheckChoice: true,
  pauseCheckScore: true,
  pausePurpose: true,
  upstream: { select: { slug: true } },
  mcpClient: { select: { name: true } },
} as const satisfies Prisma.AuditEntrySelect;
type ListRow = Prisma.AuditEntryGetPayload<{ select: typeof listSelect }>;

export function serializeListEntry(r: ListRow) {
  const result = pauseCheckResult(r);
  return {
    id: r.id,
    at: berlinIso(r.receivedAt),
    upstream: r.upstream?.slug ?? null,
    tool: r.toolName,
    client: r.mcpClient?.name ?? null,
    status: r.outcome.toLowerCase(),
    policy: r.policy,
    decisionPath: r.decisionPath,
    pauseCheck: result ? { result, choice: r.pauseCheckChoice, score: r.pauseCheckScore } : null,
    purpose: r.pausePurpose,
  };
}

export async function listHistory(userId: number, f: HistoryFilter) {
  const rows = await prisma.auditEntry.findMany({
    where: historyWhere(userId, f),
    orderBy: { id: 'desc' },
    take: f.limit + 1,
    select: listSelect,
  });
  const page = rows.slice(0, f.limit);
  return { entries: page.map(serializeListEntry), nextBefore: rows.length > f.limit ? page[page.length - 1]!.id : null };
}

// ---- one entry ----------------------------------------------------------

const entrySelect = {
  id: true,
  userId: true,
  mcpClientId: true,
  upstreamId: true,
  receivedAt: true,
  decidedAt: true,
  finishedAt: true,
  endpoint: true,
  toolName: true,
  arguments: true,
  policy: true,
  decisionPath: true,
  outcome: true,
  isError: true,
  denyReason: true,
  pausePurpose: true,
  pausePurposeSource: true,
  pauseCheckChoice: true,
  pauseCheckScore: true,
  pauseCheckInput: true,
  pauseSnoozeId: true,
  sperreScore: true,
  autoScore: true,
  intentStatus: true,
  intentTitle: true,
  intentSummary: true,
  upstream: { select: { slug: true, name: true } },
  mcpClient: { select: { name: true } },
} as const satisfies Prisma.AuditEntrySelect;
type EntryRow = Prisma.AuditEntryGetPayload<{ select: typeof entrySelect }>;

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * What Clef saw for this row. Stored text wins. Otherwise, best effort for a
 * row under an allow pause (`pauseSnoozeId`) whose Snooze row still has its
 * anchor: the same `buildState` the gate uses, from the anchor, the calls
 * forwarded under that pause before this one (same scoping as the gate: user,
 * client, upstream, pause id; newest PAUSE_CHECK_MAX_SINCE) and this call.
 */
async function clefInputOf(e: EntryRow): Promise<{ clefInput: string | null; clefInputSource: 'stored' | 'reconstructed' | null }> {
  if (e.pauseCheckInput) return { clefInput: e.pauseCheckInput, clefInputSource: 'stored' };
  const none = { clefInput: null, clefInputSource: null } as const;
  // Only a checked row (match / mismatch) had a Clef input.
  if (e.pauseSnoozeId === null || e.mcpClientId === null || e.upstreamId === null || !e.upstream) return none;
  if (pauseCheckResult(e) !== 'match' && pauseCheckResult(e) !== 'mismatch') return none;
  const userId = e.userId;
  const snooze = await prisma.snooze.findFirst({ where: { id: e.pauseSnoozeId, userId }, select: { anchorAuditId: true, purpose: true } });
  if (!snooze || snooze.anchorAuditId === null) return none;
  const anchor = await prisma.auditEntry.findFirst({
    where: { id: snooze.anchorAuditId, userId },
    select: { toolName: true, arguments: true, intentStatus: true, intentSummary: true, upstream: { select: { name: true } } },
  });
  if (!anchor) return none;
  const sinceRows = await prisma.auditEntry.findMany({
    where: {
      userId,
      mcpClientId: e.mcpClientId,
      upstreamId: e.upstreamId,
      pauseSnoozeId: e.pauseSnoozeId,
      outcome: { in: [...FORWARDED_OUTCOMES] },
      id: { lt: e.id },
    },
    orderBy: { id: 'desc' },
    take: PAUSE_CHECK_MAX_SINCE,
    select: { toolName: true, arguments: true, upstream: { select: { name: true } } },
  });
  const upstreamName = e.upstream.name;
  const call = (r: { toolName: string; arguments: string; upstream: { name: string } | null }): CheckCall => ({
    upstream: r.upstream?.name ?? upstreamName,
    tool: r.toolName,
    args: parseArgs(r.arguments),
  });
  const state = buildState({
    purpose: e.pausePurpose,
    anchor: call(anchor),
    anchorSummary: anchor.intentStatus === 'DONE' ? anchor.intentSummary : null,
    since: sinceRows.reverse().map(call),
    next: { upstream: upstreamName, tool: e.toolName, args: parseArgs(e.arguments) },
  });
  return { clefInput: state, clefInputSource: 'reconstructed' };
}

/** One entry by id, or null (missing and foreign look the same). */
export async function loadEntry(userId: number, id: number, threshold: number | null) {
  const e = await prisma.auditEntry.findFirst({ where: { id, userId }, select: entrySelect });
  if (!e) return null;
  const result = pauseCheckResult(e);
  const clef = await clefInputOf(e);
  return {
    id: e.id,
    at: berlinIso(e.receivedAt),
    decidedAt: e.decidedAt ? berlinIso(e.decidedAt) : null,
    finishedAt: e.finishedAt ? berlinIso(e.finishedAt) : null,
    upstream: e.upstream?.slug ?? null,
    tool: e.toolName,
    client: e.mcpClient?.name ?? null,
    endpoint: e.endpoint,
    arguments: parseArgs(e.arguments),
    policy: e.policy,
    decisionPath: e.decisionPath,
    status: e.outcome.toLowerCase(),
    isError: e.isError,
    denyReason: e.denyReason,
    purpose: e.pausePurpose,
    purposeSource: e.pausePurpose ? (e.pausePurposeSource ?? 'typed') : null,
    pauseCheck: result ? { result, choice: e.pauseCheckChoice, score: e.pauseCheckScore, threshold } : null,
    sperreScore: e.sperreScore,
    autoScore: e.autoScore,
    // Title and summary are advisory model output, only when finished.
    intent: e.intentStatus === 'DONE' ? { title: e.intentTitle, summary: e.intentSummary } : null,
    clefInput: clef.clefInput,
    clefInputSource: clef.clefInputSource,
  };
}
