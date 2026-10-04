import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { systemClock } from '../lib/clock.js';
import { evaluatePolicy, type Policy } from '../lib/policy.js';
import { toolHint } from '../lib/proxyText.js';
import { UpstreamNeedsReconnect, UpstreamNotConnected } from '../upstream/connection.js';
import { errorTag } from '../upstream/oauthClient.js';
import { refreshToolsFromUpstream } from '../upstream/tools.js';

// /api/upstreams/:id/tools…: the policy UI's API (ADR-0004, TC-23/25/26).
// Mounted under /api (identity). Every handler first resolves the upstream
// among the CALLER's upstreams (404 otherwise, no oracle), and every tool is
// addressed through that upstream, so a tool id of someone else's upstream is
// a 404 too. Per-client overrides only accept the caller's own MCP clients.
export const upstreamTools = new Hono<AppEnv>();

const clock = systemClock;
const NOT_FOUND = { error: 'Nicht gefunden.' };

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'no-store');
}

function parseId(raw: string | undefined): number | null {
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

const policyOrNull = z.object({ policy: z.enum(['ALLOW', 'ASK', 'DENY']).nullable() }, { error: 'Die Regel ist ungültig.' });
const policyOnly = z.object({ policy: z.enum(['ALLOW', 'ASK', 'DENY']) }, { error: 'Die Regel ist ungültig.' });

async function ownUpstream(id: number | null, userId: number) {
  if (id === null) return null;
  return prisma.upstream.findFirst({ where: { id, userId }, select: { id: true, name: true, defaultPolicy: true, status: true, auth: true } });
}

async function ownTool(upstreamId: number, toolId: number | null) {
  if (toolId === null) return null;
  return prisma.knownTool.findFirst({ where: { id: toolId, upstreamId } });
}

function parseAnnotations(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The whole policy view of one upstream. */
async function toolsView(upstreamId: number, userId: number) {
  const upstream = await ownUpstream(upstreamId, userId);
  if (!upstream) return null;
  const [tools, clients] = await Promise.all([
    prisma.knownTool.findMany({
      where: { upstreamId },
      include: { clientPolicies: { where: { mcpClient: { userId } } } },
      orderBy: [{ name: 'asc' }],
    }),
    prisma.mcpClient.findMany({ where: { userId }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
  ]);
  return {
    upstream: { id: upstream.id, name: upstream.name, defaultPolicy: upstream.defaultPolicy, status: upstream.status, auth: upstream.auth },
    clients,
    tools: tools.map((t) => {
      // Effective policy without a client override (what most clients get).
      const base = evaluatePolicy({
        upstreamDefault: upstream.defaultPolicy as Policy,
        tool: { policy: t.policy as Policy | null, acknowledgedAt: t.acknowledgedAt, changedAt: t.changedAt },
        clientOverride: null,
      });
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        hint: toolHint(parseAnnotations(t.annotations)),
        policy: t.policy,
        effectivePolicy: base.policy,
        path: base.path,
        // Not yet looked at: "Neu" (never acknowledged) or "Geändert" (its
        // definition changed after it was acknowledged, TC-36).
        isNew: t.acknowledgedAt === null && t.changedAt === null,
        isChanged: t.changedAt !== null,
        lastSeenAt: t.lastSeenAt.toISOString(),
        clientPolicies: t.clientPolicies.map((cp) => ({ mcpClientId: cp.mcpClientId, policy: cp.policy })),
      };
    }),
  };
}

upstreamTools.get('/:id/tools', async (c) => {
  noStore(c);
  const view = await toolsView(parseId(c.req.param('id')) ?? -1, c.get('user').id);
  return view ? c.json(view) : c.json(NOT_FOUND, 404);
});

// "Tools aktualisieren": fetch tools/list from the upstream now, so rules can
// be set before any agent has listed them.
upstreamTools.post('/:id/tools/refresh', async (c) => {
  noStore(c);
  const userId = c.get('user').id;
  const upstream = await ownUpstream(parseId(c.req.param('id')), userId);
  if (!upstream) return c.json(NOT_FOUND, 404);
  try {
    await refreshToolsFromUpstream(upstream.id, userId, clock);
  } catch (e) {
    if (e instanceof UpstreamNotConnected) return c.json({ error: 'Der Upstream ist noch nicht verbunden.' }, 409);
    if (e instanceof UpstreamNeedsReconnect) return c.json({ error: 'Der Upstream muss neu verbunden werden.' }, 409);
    console.warn(`upstream ${upstream.id}: tools refresh failed: ${errorTag(e)}`);
    return c.json({ error: 'Der Upstream ist gerade nicht erreichbar.' }, 502);
  }
  return c.json(await toolsView(upstream.id, userId));
});

// Set (or reset to "Standard" with null) a tool's own policy. Any change counts
// as having looked at the tool.
upstreamTools.patch('/:id/tools/:toolId', async (c) => {
  noStore(c);
  const userId = c.get('user').id;
  const upstream = await ownUpstream(parseId(c.req.param('id')), userId);
  if (!upstream) return c.json(NOT_FOUND, 404);
  const tool = await ownTool(upstream.id, parseId(c.req.param('toolId')));
  if (!tool) return c.json(NOT_FOUND, 404);
  const parsed = policyOrNull.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Die Regel ist ungültig.' }, 400);
  await prisma.knownTool.updateMany({
    where: { id: tool.id, upstreamId: upstream.id },
    data: { policy: parsed.data.policy, acknowledgedAt: clock.now(), changedAt: null },
  });
  return c.json(await toolsView(upstream.id, userId));
});

upstreamTools.post('/:id/tools/:toolId/acknowledge', async (c) => {
  noStore(c);
  const userId = c.get('user').id;
  const upstream = await ownUpstream(parseId(c.req.param('id')), userId);
  if (!upstream) return c.json(NOT_FOUND, 404);
  const tool = await ownTool(upstream.id, parseId(c.req.param('toolId')));
  if (!tool) return c.json(NOT_FOUND, 404);
  await prisma.knownTool.updateMany({ where: { id: tool.id, upstreamId: upstream.id }, data: { acknowledgedAt: clock.now(), changedAt: null } });
  return c.json(await toolsView(upstream.id, userId));
});

async function ownClient(mcpClientId: number | null, userId: number) {
  if (mcpClientId === null) return null;
  return prisma.mcpClient.findFirst({ where: { id: mcpClientId, userId }, select: { id: true } });
}

upstreamTools.put('/:id/tools/:toolId/clients/:mcpClientId', async (c) => {
  noStore(c);
  const userId = c.get('user').id;
  const upstream = await ownUpstream(parseId(c.req.param('id')), userId);
  if (!upstream) return c.json(NOT_FOUND, 404);
  const tool = await ownTool(upstream.id, parseId(c.req.param('toolId')));
  const client = await ownClient(parseId(c.req.param('mcpClientId')), userId);
  if (!tool || !client) return c.json(NOT_FOUND, 404);
  const parsed = policyOnly.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Die Regel ist ungültig.' }, 400);
  await prisma.clientToolPolicy.upsert({
    where: { toolId_mcpClientId: { toolId: tool.id, mcpClientId: client.id } },
    create: { toolId: tool.id, mcpClientId: client.id, policy: parsed.data.policy },
    update: { policy: parsed.data.policy },
  });
  return c.json(await toolsView(upstream.id, userId));
});

upstreamTools.delete('/:id/tools/:toolId/clients/:mcpClientId', async (c) => {
  noStore(c);
  const userId = c.get('user').id;
  const upstream = await ownUpstream(parseId(c.req.param('id')), userId);
  if (!upstream) return c.json(NOT_FOUND, 404);
  const tool = await ownTool(upstream.id, parseId(c.req.param('toolId')));
  const client = await ownClient(parseId(c.req.param('mcpClientId')), userId);
  if (!tool || !client) return c.json(NOT_FOUND, 404);
  await prisma.clientToolPolicy.deleteMany({ where: { toolId: tool.id, mcpClientId: client.id } });
  return c.json(await toolsView(upstream.id, userId));
});
