import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { identity, type AppEnv } from './identity.js';
import { me } from './routes/me.js';
import { upstreams } from './routes/upstreams.js';
import { upstreamTools } from './routes/upstreamTools.js';
import { mcpClients } from './routes/mcpClients.js';
import { mcpConfig } from './routes/mcpConfig.js';
import { approvalRoutes } from './routes/approvals.js';
import { audit } from './routes/audit.js';
import { push } from './routes/push.js';
import { approvals } from './approval/pending.js';
import { wireApprovalPush } from './approval/notify.js';
import { mountMcp } from './mcp/mount.js';
import { mountStatic } from './static.js';
import { MAX_API_BODY_BYTES, MAX_MCP_BODY_BYTES } from './lib/limits.js';

export const app = new Hono<AppEnv>();

app.get('/api/health', (c) =>
  c.json({ status: 'ok', version: process.env.APP_VERSION ?? 'dev' }),
);

// CSRF backstop for the state-changing API: a browser marks every request with
// Sec-Fetch-Site, and only our own SPA (same-origin) may change things. Some
// endpoints take no body (connect, acknowledge a tool) and would otherwise be
// reachable by a cross-site form POST whenever the Authelia cookie is sent
// along. Requests without the header (curl, the e2e request fixture) pass;
// the OAuth callback is a GET and so unaffected.
app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return c.json({ error: 'Anfrage von fremder Seite abgelehnt.' }, 403);
    }
  }
  await next();
});
// Body size limits (TC-44), before identity and before any route touches the
// DB: a declared Content-Length over the limit is refused at once; a chunked
// body is buffered only up to the limit.
app.use('/api/*', bodyLimit({ maxSize: MAX_API_BODY_BYTES, onError: (c) => c.json({ error: 'Die Anfrage ist zu groß.' }, 413) }));
for (const path of ['/mcp', '/mcp/*', '/oauth/*']) {
  app.use(path, bodyLimit({ maxSize: MAX_MCP_BODY_BYTES, onError: (c) => c.json({ error: 'Payload too large' }, 413) }));
}
app.use('/api/*', identity);
app.route('/api/me', me);
app.route('/api/upstreams', upstreams);
app.route('/api/upstreams', upstreamTools);
app.route('/api/mcp', mcpConfig);
app.route('/api/mcp/clients', mcpClients);
app.route('/api/approvals', approvalRoutes);
app.route('/api/audit', audit);
app.route('/api/push', push);

// Every new held call is pushed to its user's devices (ADR-0009).
wireApprovalPush(approvals);

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
