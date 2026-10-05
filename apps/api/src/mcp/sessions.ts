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
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import type { Clock } from '../lib/clock.js';

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

/** Creates the session after a successful `initialize`. Returns its id. */
export async function createSession(
  owner: SessionOwner,
  init: Record<string, unknown>,
  headers: Headers,
  clock: Clock,
): Promise<{ id: string; createdAt: Date }> {
  const now = clock.now();
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
