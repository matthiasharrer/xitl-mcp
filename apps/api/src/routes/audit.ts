// /api/audit: the user's own call history (ADR-0008, TC-35). Mounted under
// /api (identity). Every query is scoped by the caller; someone else's entry
// is a 404 like a missing one.
//
//   GET /?before=<id>   newest first, 50 per page; `nextBefore` for the next page
//   GET /:id            one entry with arguments and the result excerpt
// Both carry the advisory intent summary (ADR-0025) as intentStatus,
// intentTitle (TC-126), intentSummary, intentRisk (the floored one), intentLowered, intentAt,
// intentModel: never the stored prompt / raw answer / model risk.
import { Hono } from 'hono';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { parseNames } from '../mcp/sessions.js';

export const audit = new Hono<AppEnv>();

const PAGE = 50;
const NOT_FOUND = { error: 'Nicht gefunden.' };

function parseId(raw: string | undefined): number | null {
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const include = {
  mcpClient: { select: { name: true } },
  upstream: { select: { id: true, slug: true, name: true } },
  session: { select: { id: true, createdAt: true } },
} as const;

/** The audit row's MCP session (ADR-0016) as the UI shows it. */
export const sessionRef = (s: { id: string; createdAt: Date } | null) => (s ? { id: s.id, createdAt: s.createdAt.toISOString() } : null);

/** The audit row's intent summary as the UI may see it (TC-113). */
export function auditIntentFields(a: {
  intentStatus: string;
  intentTitle: string | null;
  intentSummary: string | null;
  intentRisk: string | null;
  intentLowered: boolean | null;
  intentAt: Date | null;
  intentModel: string | null;
}) {
  const done = a.intentStatus === 'DONE';
  return {
    intentStatus: a.intentStatus,
    intentTitle: done ? a.intentTitle : null,
    intentSummary: done ? a.intentSummary : null,
    intentRisk: done ? a.intentRisk : null,
    intentLowered: done ? (a.intentLowered ?? false) : null,
    intentAt: a.intentAt?.toISOString() ?? null,
    intentModel: a.intentModel,
  };
}

audit.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

audit.get('/', async (c) => {
  const userId = c.get('user').id;
  const before = parseId(c.req.query('before'));
  const rows = await prisma.auditEntry.findMany({
    where: { userId, ...(before !== null ? { id: { lt: before } } : {}) },
    orderBy: { id: 'desc' },
    take: PAGE + 1,
    include,
  });
  const page = rows.slice(0, PAGE);
  return c.json({
    entries: page.map((a) => ({
      id: a.id,
      tool: a.toolName,
      upstream: a.upstream,
      clientName: a.mcpClient?.name ?? null,
      /** The McpClient row id (null once revoked): the UI groups by it. */
      clientId: a.mcpClientId,
      outcome: a.outcome,
      decisionPath: a.decisionPath,
      isError: a.isError,
      receivedAt: a.receivedAt.toISOString(),
      session: sessionRef(a.session),
      ...auditIntentFields(a),
    })),
    nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null,
  });
});

audit.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json(NOT_FOUND, 404);
  const a = await prisma.auditEntry.findFirst({ where: { id, userId: c.get('user').id }, include });
  if (!a) return c.json(NOT_FOUND, 404);
  return c.json({
    id: a.id,
    tool: a.toolName,
    upstream: a.upstream,
    clientName: a.mcpClient?.name ?? null,
    endpoint: a.endpoint,
    policy: a.policy,
    outcome: a.outcome,
    decisionPath: a.decisionPath,
    isError: a.isError,
    arguments: parseArgs(a.arguments),
    resultText: a.resultText,
    receivedAt: a.receivedAt.toISOString(),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    finishedAt: a.finishedAt?.toISOString() ?? null,
    session: sessionRef(a.session),
    ...auditIntentFields(a),
    // Per-call diagnostics (names only; ADR-0016 measurement).
    diagnostics: {
      protocolVersion: a.protocolVersion,
      clientInfo: a.clientInfo,
      userAgent: a.userAgent,
      headerNames: a.headerNames ? parseNames(a.headerNames) : [],
      metaKeys: a.metaKeys ? parseNames(a.metaKeys) : [],
      traceId: a.traceId,
      cloudTraceId: a.cloudTraceId,
      anthropicClient: a.anthropicClient,
    },
  });
});
