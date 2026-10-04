import { Hono } from 'hono';
import { identity, type AppEnv } from './identity.js';
import { me } from './routes/me.js';
import { upstreams } from './routes/upstreams.js';
import { mcpClients } from './routes/mcpClients.js';
import { mcpConfig } from './routes/mcpConfig.js';
import { mountMcp } from './mcp/mount.js';
import { mountStatic } from './static.js';

export const app = new Hono<AppEnv>();

app.get('/api/health', (c) =>
  c.json({ status: 'ok', version: process.env.APP_VERSION ?? 'dev' }),
);

app.use('/api/*', identity);
app.route('/api/me', me);
app.route('/api/upstreams', upstreams);
app.route('/api/mcp', mcpConfig);
app.route('/api/mcp/clients', mcpClients);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

// MCP (ADR-0012, ADR-0014): /mcp/<slug>, /mcp/register, /mcp/token and
// /.well-known/* are exempt from Authelia at the ingress (bearer auth instead);
// /oauth/authorize is NOT (it sits behind identity, mounted in
// mcp/oauthRoutes.ts). Must come before mountStatic, whose wildcard would
// otherwise swallow them.
mountMcp(app);

mountStatic(app as unknown as Hono);
