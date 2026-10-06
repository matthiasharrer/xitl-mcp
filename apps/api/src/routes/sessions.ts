// /api/sessions: the user's own MCP sessions (ADR-0016, TC-59, TC-60).
// Mounted under /api (identity). Every query is scoped by the caller; another
// user's session is a 404 like a missing one.
//
//   GET /?before=<id>   newest first, 50 per page; `nextBefore` for the next page
//   GET /:id            one session + diagnostics (header names, `_meta` keys)
//                       + its calls (newest first, at most 200)
import { Hono } from 'hono';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { isSessionId, parseNames } from '../mcp/sessions.js';
import { auditIntentFields } from './audit.js';

export const sessions = new Hono<AppEnv>();

const PAGE = 50;
const MAX_CALLS = 200;
const NOT_FOUND = { error: 'Nicht gefunden.' };

const include = {
  mcpClient: { select: { id: true, name: true, kind: true } },
  upstream: { select: { id: true, slug: true, name: true } },
} as const;

type Row = NonNullable<Awaited<ReturnType<typeof findRow>>>;

function findRow(id: string, userId: number) {
  return prisma.mcpSession.findFirst({ where: { id, userId }, include });
}

function summary(s: Row) {
  return {
    id: s.id,
    client: s.mcpClient,
    upstream: s.upstream,
    clientInfo: { name: s.clientName, version: s.clientVersion },
    protocolVersion: s.protocolVersion,
    userAgent: s.userAgent,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    callCount: s.callCount,
  };
}

sessions.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

sessions.get('/', async (c) => {
  const userId = c.get('user').id;
  const beforeRaw = c.req.query('before');
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
  let rows: Row[];
  if (beforeRaw !== undefined) {
    // The cursor must be one of the caller's own sessions.
    const cursor = isSessionId(beforeRaw) ? await prisma.mcpSession.findFirst({ where: { id: beforeRaw, userId }, select: { id: true } }) : null;
    if (!cursor) return c.json({ sessions: [], nextBefore: null });
    rows = await prisma.mcpSession.findMany({ where: { userId }, orderBy, cursor: { id: cursor.id }, skip: 1, take: PAGE + 1, include });
  } else {
    rows = await prisma.mcpSession.findMany({ where: { userId }, orderBy, take: PAGE + 1, include });
  }
  const page = rows.slice(0, PAGE);
  return c.json({ sessions: page.map(summary), nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null });
});

sessions.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isSessionId(id)) return c.json(NOT_FOUND, 404);
  const userId = c.get('user').id;
  const s = await findRow(id, userId);
  if (!s) return c.json(NOT_FOUND, 404);
  const calls = await prisma.auditEntry.findMany({
    where: { sessionId: s.id, userId },
    orderBy: { id: 'desc' },
    take: MAX_CALLS,
    include: { mcpClient: { select: { name: true } }, upstream: { select: { id: true, slug: true, name: true } } },
  });
  return c.json({
    ...summary(s),
    headerNames: parseNames(s.headerNames),
    metaKeys: parseNames(s.metaKeys),
    entries: calls.map((a) => ({
      id: a.id,
      tool: a.toolName,
      upstream: a.upstream,
      clientName: a.mcpClient?.name ?? null,
      outcome: a.outcome,
      decisionPath: a.decisionPath,
      isError: a.isError,
      receivedAt: a.receivedAt.toISOString(),
      session: { id: s.id, createdAt: s.createdAt.toISOString() },
      // TC-126: the title as headline (and the rest of the advisory fields).
      ...auditIntentFields(a),
    })),
  });
});
