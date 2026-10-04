// /api/push: Web Push subscriptions (ADR-0009), copied from haushalts-todos'
// routes/push.ts. Mounted under /api (identity). A subscription belongs to
// the caller; an endpoint subscribed again by another user moves to them (same
// browser, other person), which needs the endpoint URL itself, a capability
// only that browser holds.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { describeFailure, getVapid, sendToSubscriptions } from '../lib/push.js';

export const push = new Hono<AppEnv>();

const subscribeSchema = z.object({
  endpoint: z
    .string()
    .max(2000)
    .refine((v) => {
      try {
        return new URL(v).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'must be an https URL'),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});
const endpointSchema = z.object({ endpoint: z.string().min(1).max(2000) });

class BadRequest extends Error {}

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    throw new BadRequest('Ungültige Anfrage.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest('Ungültige Anfrage.');
  return parsed.data;
}

push.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  throw err;
});

push.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

push.get('/config', async (c) => c.json({ publicKey: (await getVapid()).publicKey }));

push.post('/subscriptions', async (c) => {
  const { endpoint, keys } = await body(c, subscribeSchema);
  const userId = c.get('user').id;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userId },
    update: { p256dh: keys.p256dh, auth: keys.auth, userId },
  });
  return c.json({ ok: true }, 201);
});

push.delete('/subscriptions', async (c) => {
  const { endpoint } = await body(c, endpointSchema);
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: c.get('user').id } });
  return c.body(null, 204);
});

push.post('/test', async (c) => {
  const { endpoint } = await body(c, endpointSchema);
  const sub = await prisma.pushSubscription.findFirst({ where: { endpoint, userId: c.get('user').id } });
  if (!sub) return c.json({ error: 'Dieses Gerät ist nicht angemeldet.' }, 404);
  const [failure] = await sendToSubscriptions(
    [sub],
    { type: 'test', title: 'Test-Benachrichtigung', body: 'Push funktioniert.' },
    { ttl: 60, urgency: 'normal' },
  );
  // The one push the user waits for: say what went wrong instead of a silent 204.
  if (failure) return c.json({ error: describeFailure(failure) }, 502);
  return c.body(null, 204);
});
