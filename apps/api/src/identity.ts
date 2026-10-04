import { createMiddleware } from 'hono/factory';
import { prisma } from './db.js';
import type { User } from './generated/prisma/client.js';

export type AppEnv = { Variables: { user: User } };

/** Empty/whitespace header values count as absent. */
function value(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

// Authelia's ForwardAuth sets Remote-User/-Name/-Email/-Groups at the ingress
// (Traefik strips any client-supplied copy first), so on /api/* they are
// trustworthy. Here identity is real: upsert a User keyed by Remote-User and
// put it on the context. /api/health is exempt (probes carry no identity).
export const identity = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.path === '/api/health') return next();

  const username = value(c.req.header('remote-user'));
  if (!username) return c.json({ error: 'Unauthorized: missing Remote-User' }, 401);

  const displayName = value(c.req.header('remote-name')) ?? username;
  const email = value(c.req.header('remote-email'));

  const existing = await prisma.user.findUnique({ where: { username } });
  let user: User;
  if (!existing) {
    user = await prisma.user.upsert({
      where: { username },
      create: { username, displayName, email },
      update: { displayName, email },
    });
  } else if (existing.displayName !== displayName || existing.email !== email) {
    user = await prisma.user.update({ where: { username }, data: { displayName, email } });
  } else {
    user = existing;
  }
  c.set('user', user);
  await next();
});
