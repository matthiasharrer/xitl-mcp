import { Hono } from 'hono';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { approvals } from '../approval/pending.js';

// GET/PATCH/DELETE /api/mcp/clients - the management surface for MCP OAuth
// clients (copied from haushalts-todos), restricted to the CALLER's own
// clients (ADR-0010, ADR-0012): every query is scoped by `userId = c.get('user').id`, and
// someone else's client answers 404, exactly like a missing one (no oracle).
// Mounted under /api, so it sits behind the identity middleware.
//
// Clients are addressed by numeric `id`, never the opaque `clientId` (a live
// OAuth value that must stay out of URLs). Responses never include `clientId`,
// `redirectUris` or `userId`.
export const mcpClients = new Hono<AppEnv>();

const listSelect = { id: true, name: true, createdAt: true, lastUsedAt: true } as const;

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'no-store');
}

function serialize(row: { id: number; name: string; createdAt: Date; lastUsedAt: Date | null }) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
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

// PATCH /api/mcp/clients/:id - body { name }, trimmed; empty -> 400.
mcpClients.patch('/:id', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).name : undefined;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '' || name.length > 100) return c.json({ error: 'name darf nicht leer sein' }, 400);

  const userId = c.get('user').id;
  const res = await prisma.mcpClient.updateMany({ where: { id, userId }, data: { name } });
  if (res.count === 0) return c.json({ error: 'not found' }, 404);
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
