import { Hono } from 'hono';
import type { AppEnv } from '../identity.js';

export const me = new Hono<AppEnv>();

me.get('/', (c) => {
  const user = c.get('user');
  return c.json({ id: user.id, username: user.username, displayName: user.displayName });
});
