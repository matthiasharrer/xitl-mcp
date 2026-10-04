import { Hono } from 'hono';

// GET /api/mcp/config (copied from haushalts-todos) - tells the settings page
// whether MCP is configured, so it can show the endpoint URLs to paste into
// Claude (they are built from the upstream slugs, ADR-0014). Reports only
// `{ configured }`: the raw MCP_TOKEN is the HMAC signing secret
// (never a bearer, ADR-0012) and is never put on the wire.
export const mcpConfig = new Hono();

mcpConfig.get('/config', (c) => {
  c.header('Cache-Control', 'no-store');
  const configured = (process.env.MCP_TOKEN ?? '') !== '';
  return c.json({ configured });
});
