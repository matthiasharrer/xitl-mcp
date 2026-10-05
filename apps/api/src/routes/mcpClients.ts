import { Hono } from 'hono';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { approvals } from '../approval/pending.js';
import crypto from 'node:crypto';
import { generateAccessToken, hashAccessToken, tokenDisplayPrefix } from '../lib/accessToken.js';
import { parseAllowedOrigins, storedOrigins } from '../lib/origins.js';
import { systemClock } from '../lib/clock.js';

const clock = systemClock;

// GET/PATCH/DELETE /api/mcp/clients - the management surface for MCP OAuth
// clients (copied from haushalts-todos), restricted to the CALLER's own
// clients (ADR-0010, ADR-0012): every query is scoped by `userId = c.get('user').id`, and
// someone else's client answers 404, exactly like a missing one (no oracle).
// Mounted under /api, so it sits behind the identity middleware.
//
// Clients are addressed by numeric `id`, never the opaque `clientId` (a live
// OAuth value that must stay out of URLs). Responses never include `clientId`,
// `redirectUris`, `userId` or the token hash (TOKEN clients, ADR-0015, are listed
// with their upstream, display prefix and allowed browser origins, ADR-0023).
// Every client carries `pausedAt` (ADR-0024: ISO while paused, else null).
export const mcpClients = new Hono<AppEnv>();

export const clientSelect = {
  id: true,
  name: true,
  kind: true,
  tokenPrefix: true,
  allUpstreams: true,
  allowedOrigins: true,
  pausedAt: true,
  createdAt: true,
  lastUsedAt: true,
  upstream: { select: { id: true, slug: true, name: true } },
} as const;
const listSelect = clientSelect;

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'no-store');
}

type ClientRow = {
  id: number;
  name: string;
  kind: 'OAUTH' | 'TOKEN';
  tokenPrefix: string | null;
  allUpstreams: boolean;
  allowedOrigins: string;
  pausedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  upstream: { id: number; slug: string; name: string } | null;
};

// The one serializer: never the token hash, clientId, redirectUris or userId.
export function serializeClient(row: ClientRow) {
  const isToken = row.kind === 'TOKEN';
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    upstream: isToken ? row.upstream : null,
    /** TOKEN scope (ADR-0018): true = all upstreams (upstream is then null). */
    allUpstreams: isToken && row.allUpstreams,
    tokenPrefix: isToken ? row.tokenPrefix : null,
    /** ADR-0023: web pages that may use this token from a browser. */
    allowedOrigins: isToken ? storedOrigins(row.allowedOrigins) : [],
    /** ADR-0024: since when the access is paused; null = active. */
    pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}
const serialize = serializeClient;

/** Creates a TOKEN client (ADR-0015, ADR-0018) for `userId` with exactly one
 * scope: one upstream (already checked to be the user's) or all upstreams.
 * The returned token is the ONLY copy; only its SHA-256 is stored. */
export async function createTokenClient(
  userId: number,
  name: string,
  scope: { upstreamId: number } | { allUpstreams: true },
  /** Already validated and normalized (lib/origins.ts parseAllowedOrigins). */
  allowedOrigins: string[] = [],
) {
  const token = generateAccessToken();
  const row = await prisma.mcpClient.create({
    data: {
      kind: 'TOKEN',
      clientId: crypto.randomBytes(24).toString('base64url'),
      name,
      redirectUris: '[]',
      userId,
      ...('allUpstreams' in scope ? { allUpstreams: true, upstreamId: null } : { allUpstreams: false, upstreamId: scope.upstreamId }),
      tokenHash: hashAccessToken(token),
      tokenPrefix: tokenDisplayPrefix(token),
      allowedOrigins: JSON.stringify(allowedOrigins),
    },
    select: clientSelect,
  });
  return { client: serializeClient(row), token };
}

function parseId(raw: string | undefined): number | null {
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

// Most recently used first; never-used (NULL) sort after used ones in SQLite's
// desc order, then newest registration first.
mcpClients.get('/', async (c) => {
  noStore(c);
  const rows = await prisma.mcpClient.findMany({
    where: { userId: c.get('user').id },
    select: listSelect,
    orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
  });
  return c.json(rows.map(serialize));
});

/** The 400 for origins on an OAuth client (ADR-0023). */
export const ORIGINS_TOKEN_ONLY = {
  error: 'Web-Adressen gibt es nur für Zugangstokens.',
  code: 'origins_token_only',
} as const;

// PATCH /api/mcp/clients/:id - body { name?, allowedOrigins?, paused? } (at
// least one). name: trimmed, empty -> 400. allowedOrigins (ADR-0023): replaces
// the list (also with []), TOKEN clients only (OAUTH -> 400 origins_token_only).
// paused (ADR-0024), any client: true sets `pausedAt` only where it is null
// (the first pause is kept) and settles the client's held calls as "paused";
// false clears it. The gate (mcp/mount.ts) refuses a paused client.
mcpClients.patch('/:id', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const data: { name?: string; allowedOrigins?: string } = {};
  if (fields.paused !== undefined && typeof fields.paused !== 'boolean') {
    return c.json({ error: 'paused muss true oder false sein.' }, 400);
  }
  const paused = fields.paused as boolean | undefined;
  if (fields.name !== undefined || (fields.allowedOrigins === undefined && paused === undefined)) {
    const name = typeof fields.name === 'string' ? fields.name.trim() : '';
    if (name === '' || name.length > 100) return c.json({ error: 'name darf nicht leer sein' }, 400);
    data.name = name;
  }

  const userId = c.get('user').id;
  const existing = await prisma.mcpClient.findFirst({ where: { id, userId }, select: { kind: true } });
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (fields.allowedOrigins !== undefined) {
    if (existing.kind !== 'TOKEN') return c.json(ORIGINS_TOKEN_ONLY, 400);
    const parsed = parseAllowedOrigins(fields.allowedOrigins);
    if (!parsed.ok) return c.json({ error: parsed.error, code: 'invalid_origin' }, 400);
    data.allowedOrigins = JSON.stringify(parsed.origins);
  }

  if (data.name !== undefined || data.allowedOrigins !== undefined) {
    // kind in the where: an OAuth row can never get origins, whatever raced.
    const where = data.allowedOrigins !== undefined ? { id, userId, kind: 'TOKEN' as const } : { id, userId };
    const res = await prisma.mcpClient.updateMany({ where, data });
    if (res.count === 0) return c.json({ error: 'not found' }, 404);
  }
  if (paused === true) {
    // Only where not yet paused: pausing again keeps the first pausedAt.
    await prisma.mcpClient.updateMany({ where: { id, userId, pausedAt: null }, data: { pausedAt: clock.now() } });
    // Held calls end denied at once ("+paused"); mcp/server.ts re-checks the
    // pause after an approval for a call that was not yet held right now.
    approvals.cancelWhere((call) => call.userId === userId && call.mcpClientId === id, 'paused');
  } else if (paused === false) {
    await prisma.mcpClient.updateMany({ where: { id, userId }, data: { pausedAt: null } });
  }
  const row = await prisma.mcpClient.findFirst({ where: { id, userId }, select: listSelect });
  return row ? c.json(serialize(row)) : c.json({ error: 'not found' }, 404);
});

// DELETE /api/mcp/clients/:id - the revoke button. Deleting the row is the
// whole mechanism: mcp/verifier.ts refuses a token whose client row is gone,
// and /mcp/token refuses to mint for it, so it takes effect on the very next
// request. Its held calls end denied right away ("+revoked", TC-41), and its
// snoozes and per-client rules go with the row (cascade).
mcpClients.delete('/:id', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'not found' }, 404);
  const userId = c.get('user').id;
  const res = await prisma.mcpClient.deleteMany({ where: { id, userId } });
  if (res.count === 0) return c.json({ error: 'not found' }, 404);
  approvals.cancelWhere((call) => call.userId === userId && call.mcpClientId === id);
  return c.body(null, 204);
});
