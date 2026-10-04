import { Hono } from 'hono';
import { identity, type AppEnv } from './identity.js';
import { me } from './routes/me.js';
import { mountStatic } from './static.js';

export const app = new Hono<AppEnv>();

app.get('/api/health', (c) =>
  c.json({ status: 'ok', version: process.env.APP_VERSION ?? 'dev' }),
);

app.use('/api/*', identity);
app.route('/api/me', me);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

// The proxy endpoint (/mcp/...) and the OAuth endpoints get mounted here, before
// mountStatic, whose wildcard would otherwise swallow them.

mountStatic(app as unknown as Hono);
