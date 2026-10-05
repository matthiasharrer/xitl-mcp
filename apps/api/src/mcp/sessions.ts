// MCP sessions on /mcp/<slug> and /mcp (ADR-0016, ADR-0017). Request handling stays per request
// (the SDK's stateless `createMcpHandler`); a session is only a DB row that
// mount.ts creates on a 2025-era `initialize` (id returned as `Mcp-Session-Id`)
// and checks on later requests that carry the header.
//
// What the protocol does (SDK 2.2.0, see docs/architecture.md):
// - 2025-era revisions (2024-11-05 … 2025-11-25) start with `initialize`;
//   Streamable HTTP lets the server issue `Mcp-Session-Id` on the initialize
//   response, the client then sends it on every request and may DELETE it.
//   The SDK serves these per request with `sessionIdGenerator: undefined` and
//   ignores the header, so this module adds the session on top.
// - The 2026-07-28 revision has no `initialize` and no sessions at all: every
//   request carries a `_meta` envelope (`io.modelcontextprotocol/protocolVersion`,
//   clientInfo, clientCapabilities). Such clients stay sessionless.
//
// Security: a session id is NEVER a credential. It is looked up only after the
// bearer token was verified, and only accepted for the same user + MCP client
// + upstream; anything else (unknown, foreign, ended, malformed) is the same
// 404 so it says nothing about other sessions. Only header NAMES are stored,
// plus the values of User-Agent and MCP-Protocol-Version; never Authorization
// or cookies.
//
// Expiry (ADR-0016 amendment): almost no client sends DELETE, so a row would
// be added per `initialize` forever. Sessions not seen for SESSION_TTL_MS are
// deleted, and at most MAX_SESSIONS_PER_USER are kept per user (least
// recently seen evicted first). Cleanup runs at boot (all users) and before
// every new session (that user only); there is no timer. Audit rows stay
// (`AuditEntry.session` is `onDelete: SetNull`). A deleted id is the same 404
// as an unknown one, and the client re-initializes.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import type { Clock } from '../lib/clock.js';
import { MAX_SESSIONS_PER_USER, SESSION_TTL_MS } from '../lib/limits.js';
import { errorTag } from '../upstream/oauthClient.js';

/** `lastSeenAt` alone is written at most this often. */
export const LAST_SEEN_MIN_INTERVAL_MS = 60_000;
/** Caps for the diagnostics (a client controls all of it). */
export const MAX_HEADER_NAMES = 100;
export const MAX_META_KEYS = 100;
const MAX_NAME_CHARS = 100;
const MAX_META_KEY_CHARS = 200;
const MAX_CLIENT_INFO_CHARS = 200;
const MAX_USER_AGENT_CHARS = 500;
const MAX_PROTOCOL_VERSION_CHARS = 40;

/** The `_meta` key that marks a 2026-07-28-era request (no sessions there). */
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

/** 256 random bits, base64url: 43 visible-ASCII characters (spec: 0x21–0x7E). */
export function newSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function isSessionId(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw);
}

const clip = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The JSON-RPC messages of a POST body (one or a batch); [] when not JSON-RPC. */
export function messagesOf(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body) ? body : [body];
  return list.filter(isObject);
}

function metaOf(m: Record<string, unknown>): Record<string, unknown> | null {
  const params = m.params;
  return isObject(params) && isObject(params._meta) ? params._meta : null;
}

/** A 2025-era handshake: `initialize` without a 2026 `_meta` envelope. */
export function legacyInitializeOf(messages: Record<string, unknown>[]): Record<string, unknown> | null {
  for (const m of messages) {
    if (m.method !== 'initialize') continue;
    const meta = metaOf(m);
    if (meta && PROTOCOL_VERSION_META_KEY in meta) continue;
    return m;
  }
  return null;
}

/** What `initialize.params` says about the client (untrusted, clipped). */
export function clientInfoOf(init: Record<string, unknown>) {
  const params = isObject(init.params) ? init.params : {};
  const info = isObject(params.clientInfo) ? params.clientInfo : {};
  return {
    clientName: clip(info.name, MAX_CLIENT_INFO_CHARS),
    clientVersion: clip(info.version, MAX_CLIENT_INFO_CHARS),
    protocolVersion: clip(params.protocolVersion, MAX_PROTOCOL_VERSION_CHARS),
  };
}

/** Number of `tools/call` requests and the `_meta` keys they carry. */
export function toolCallsOf(messages: Record<string, unknown>[]): { calls: number; metaKeys: string[] } {
  let calls = 0;
  const keys: string[] = [];
  for (const m of messages) {
    if (m.method !== 'tools/call') continue;
    calls++;
    const meta = metaOf(m);
    if (meta) keys.push(...Object.keys(meta));
  }
  return { calls, metaKeys: keys };
}

/** Lower-cased request header names. Names only, never values. */
export function headerNamesOf(headers: Headers): string[] {
  const names: string[] = [];
  headers.forEach((_value, name) => names.push(name.toLowerCase()));
  return names;
}

/** Union of a stored JSON array and new names: sorted, de-duplicated, capped. */
export function mergeNames(storedJson: string, add: string[], maxItems: number, maxChars: number): string[] {
  const set = new Set(parseNames(storedJson));
  for (const raw of add) {
    if (set.size >= maxItems) break;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxChars) continue;
    set.add(raw);
  }
  return [...set].sort();
}

export function parseNames(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface SessionOwner {
  userId: number;
  mcpClientId: number;
  /** null: the unified `/mcp` (ADR-0017). Matched exactly, so a `/mcp` session
   * is never valid on `/mcp/<slug>` and vice versa. */
  upstreamId: number | null;
}

export type SessionRow = NonNullable<Awaited<ReturnType<typeof findOwnSession>>>;

/** The caller's own open session, or null for anything else (no oracle). */
export async function findOwnSession(id: string, owner: SessionOwner) {
  if (!isSessionId(id)) return null;
  return prisma.mcpSession.findFirst({
    where: { id, userId: owner.userId, mcpClientId: owner.mcpClientId, upstreamId: owner.upstreamId, endedAt: null },
  });
}

export interface SessionPruneOptions {
  maxAgeMs?: number;
  maxPerUser?: number;
  /** Slots to leave free below `maxPerUser`: 1 right before a session is
   * created, so that afterwards the user has at most `maxPerUser`. */
  reserve?: number;
}

/**
 * Which sessions to delete: every one last seen more than `maxAgeMs` before
 * `now` (exactly `maxAgeMs` stays), then, per user, the least recently seen
 * (ties by id) until at most `maxPerUser - reserve` of that user remain. Each
 * user is counted on their own: one user's sessions never push out another's.
 * Pure.
 */
export function sessionsToPrune(
  rows: { id: string; userId: number; lastSeenAt: Date }[],
  now: Date,
  opts: SessionPruneOptions = {},
): string[] {
  const maxAgeMs = opts.maxAgeMs ?? SESSION_TTL_MS;
  const keep = Math.max(0, (opts.maxPerUser ?? MAX_SESSIONS_PER_USER) - (opts.reserve ?? 0));
  const cutoff = now.getTime() - maxAgeMs;
  const out: string[] = [];
  const liveByUser = new Map<number, { id: string; lastSeenAt: Date }[]>();
  for (const r of rows) {
    if (r.lastSeenAt.getTime() < cutoff) {
      out.push(r.id);
      continue;
    }
    const list = liveByUser.get(r.userId) ?? [];
    list.push(r);
    liveByUser.set(r.userId, list);
  }
  for (const live of liveByUser.values()) {
    live.sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push(...live.slice(0, Math.max(0, live.length - keep)).map((r) => r.id));
  }
  return out;
}

/** Ids per DELETE statement (SQLite bound-parameter limit). */
const PRUNE_CHUNK = 500;

/** Deletes sessions per `sessionsToPrune`: of one user (`userId`, before
 * that user's new session) or of everyone (boot). The delete is scoped to
 * the user too. Returns how many rows were deleted. */
export async function pruneSessions(now: Date, opts: SessionPruneOptions & { userId?: number } = {}): Promise<number> {
  const scope = opts.userId !== undefined ? { userId: opts.userId } : {};
  const rows = await prisma.mcpSession.findMany({ where: scope, select: { id: true, userId: true, lastSeenAt: true } });
  const ids = sessionsToPrune(rows, now, opts);
  let count = 0;
  for (let i = 0; i < ids.length; i += PRUNE_CHUNK) {
    const res = await prisma.mcpSession.deleteMany({ where: { ...scope, id: { in: ids.slice(i, i + PRUNE_CHUNK) } } });
    count += res.count;
  }
  if (count > 0) console.log(`mcp: ${count} expired session(s) removed`);
  return count;
}

/** Creates the session after a successful `initialize`. Returns its id.
 * First makes room for it (expired ones and any over the cap, this user
 * only); a failure there is logged and never blocks the new session. */
export async function createSession(
  owner: SessionOwner,
  init: Record<string, unknown>,
  headers: Headers,
  clock: Clock,
): Promise<{ id: string; createdAt: Date }> {
  const now = clock.now();
  try {
    await pruneSessions(now, { userId: owner.userId, reserve: 1 });
  } catch (e) {
    console.warn(`mcp: session cleanup failed: ${errorTag(e)}`);
  }
  const id = newSessionId();
  await prisma.mcpSession.create({
    data: {
      id,
      ...owner,
      ...clientInfoOf(init),
      userAgent: clip(headers.get('user-agent'), MAX_USER_AGENT_CHARS),
      headerNames: JSON.stringify(mergeNames('[]', headerNamesOf(headers), MAX_HEADER_NAMES, MAX_NAME_CHARS)),
      createdAt: now,
      lastSeenAt: now,
    },
  });
  return { id, createdAt: now };
}

/** Records one request on a session: header names, `_meta` keys, tools/call
 * count, the negotiated protocol version (header), lastSeenAt (throttled when
 * nothing else changed). Diagnostics only: a failure here is logged by the
 * caller and never blocks the request. */
export async function touchSession(
  session: SessionRow,
  req: { headers: Headers; messages: Record<string, unknown>[] },
  clock: Clock,
): Promise<void> {
  const now = clock.now();
  const { calls, metaKeys } = toolCallsOf(req.messages);
  const headerNames = mergeNames(session.headerNames, headerNamesOf(req.headers), MAX_HEADER_NAMES, MAX_NAME_CHARS);
  const meta = mergeNames(session.metaKeys, metaKeys, MAX_META_KEYS, MAX_META_KEY_CHARS);
  const headerJson = JSON.stringify(headerNames);
  const metaJson = JSON.stringify(meta);
  const version = clip(req.headers.get('mcp-protocol-version'), MAX_PROTOCOL_VERSION_CHARS);
  const versionChanged = version !== null && version !== session.protocolVersion;
  const stale = now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_MIN_INTERVAL_MS;
  const changed = calls > 0 || headerJson !== session.headerNames || metaJson !== session.metaKeys || versionChanged;
  if (!changed && !stale) return;
  await prisma.mcpSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: now,
      ...(calls > 0 ? { callCount: { increment: calls } } : {}),
      ...(headerJson !== session.headerNames ? { headerNames: headerJson } : {}),
      ...(metaJson !== session.metaKeys ? { metaKeys: metaJson } : {}),
      ...(versionChanged ? { protocolVersion: version } : {}),
    },
  });
}

/** DELETE /mcp/<slug> or /mcp: ends the session for good. */
export async function endSession(session: SessionRow, clock: Clock): Promise<void> {
  const now = clock.now();
  await prisma.mcpSession.updateMany({ where: { id: session.id, endedAt: null }, data: { endedAt: now, lastSeenAt: now } });
}

/** The SDK's own answer for an unknown session (sessionful transport):
 * HTTP 404, JSON-RPC -32001 "Session not found". The client re-initializes. */
export function sessionNotFound(id: string | number | null = null): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id }, { status: 404 });
}

/** `id` of a single JSON-RPC request, for the error body; null otherwise. */
export function echoableId(messages: Record<string, unknown>[], isBatch: boolean): string | number | null {
  if (isBatch || messages.length !== 1) return null;
  const { id, method } = messages[0]!;
  return typeof method === 'string' && (typeof id === 'string' || typeof id === 'number') ? id : null;
}

/** The `_meta` key carrying clientInfo on 2026-07-28-era requests. */
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/** What one request says about its client, stored on each audit row so calls
 * can be told apart even without a session (ADR-0016 measurement). Untrusted,
 * clipped; header NAMES only, plus the values of User-Agent and
 * MCP-Protocol-Version (never Authorization or cookies). */
export interface RequestDiagnostics {
  protocolVersion: string | null;
  clientName: string | null;
  clientVersion: string | null;
  userAgent: string | null;
  headerNames: string[];
  metaKeys: string[];
  /** Correlation candidates for grouping without sessions (MG-06 finding:
   * Claude.ai speaks 2026-07-28). Only the TRACE part of each trace header
   * (random ids, not credentials), and the x-anthropic-client value. */
  traceId: string | null;
  cloudTraceId: string | null;
  anthropicClient: string | null;
}

/** W3C `traceparent`: version-traceid-parentid-flags -> the trace id. */
export function traceIdOf(raw: string | null): string | null {
  const m = raw?.trim().toLowerCase().match(/^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/);
  return m && !/^0+$/.test(m[1]!) ? m[1]! : null;
}

/** GCP `x-cloud-trace-context`: TRACE_ID[/SPAN_ID][;o=N] -> the trace id. */
export function cloudTraceIdOf(raw: string | null): string | null {
  const m = raw?.trim().toLowerCase().match(/^([0-9a-f]{32})(?:\/\d{1,20})?(?:;o=\d)?$/);
  return m ? m[1]! : null;
}

/** A short printable token, or null (the header value is client-controlled). */
function tokenValue(raw: string | null, max: number): string | null {
  return raw && /^[\x21-\x7e]{1,200}$/.test(raw) ? raw.slice(0, max) : null;
}

export function requestDiagnostics(headers: Headers, messages: Record<string, unknown>[]): RequestDiagnostics {
  const call = messages.find((m) => m.method === 'tools/call') ?? messages[0];
  const meta = call ? metaOf(call) : null;
  const info = meta && isObject(meta[CLIENT_INFO_META_KEY]) ? (meta[CLIENT_INFO_META_KEY] as Record<string, unknown>) : {};
  return {
    protocolVersion:
      clip(headers.get('mcp-protocol-version'), MAX_PROTOCOL_VERSION_CHARS) ??
      clip(meta?.[PROTOCOL_VERSION_META_KEY], MAX_PROTOCOL_VERSION_CHARS),
    clientName: clip(info.name, MAX_CLIENT_INFO_CHARS),
    clientVersion: clip(info.version, MAX_CLIENT_INFO_CHARS),
    userAgent: clip(headers.get('user-agent'), MAX_USER_AGENT_CHARS),
    headerNames: mergeNames('[]', headerNamesOf(headers), MAX_HEADER_NAMES, MAX_NAME_CHARS),
    metaKeys: mergeNames('[]', toolCallsOf(messages).metaKeys, MAX_META_KEYS, MAX_META_KEY_CHARS),
    traceId: traceIdOf(headers.get('traceparent')),
    cloudTraceId: cloudTraceIdOf(headers.get('x-cloud-trace-context')),
    anthropicClient: tokenValue(headers.get('x-anthropic-client'), 100),
  };
}
