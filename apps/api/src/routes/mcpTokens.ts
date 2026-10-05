// POST /api/mcp/tokens - body { name, allowedOrigins? } -> 201 { client, token }: an access
// token for ALL of the caller's upstreams (ADR-0018), valid on `/mcp` and every
// `/mcp/<slug>` of this user. One-upstream tokens are created under
// /api/upstreams/:id/tokens. The response is the only place the token appears.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../identity.js';
import { createTokenClient } from './mcpClients.js';
import { firstMessage, nameSchema } from './upstreams.js';
import { parseAllowedOrigins } from '../lib/origins.js';

export const mcpTokens = new Hono<AppEnv>();

mcpTokens.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ name: nameSchema, allowedOrigins: z.unknown().optional() }).safeParse(body);
  if (!parsed.success) return c.json({ error: firstMessage(parsed.error) }, 400);
  // ADR-0023: optional browser origins, validated and normalized.
  const origins = parsed.data.allowedOrigins === undefined ? { ok: true as const, origins: [] } : parseAllowedOrigins(parsed.data.allowedOrigins);
  if (!origins.ok) return c.json({ error: origins.error, code: 'invalid_origin' }, 400);
  const { client, token } = await createTokenClient(c.get('user').id, parsed.data.name, { allUpstreams: true }, origins.origins);
  return c.json({ client, token }, 201);
});
