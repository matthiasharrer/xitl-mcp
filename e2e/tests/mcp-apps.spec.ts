// MCP Apps, slice 1 (ADR-0038): TC-240…242. xitl serves no views yet, so no
// tool may point a client at one (Claude.ai would spin forever on
// "Verbindung wird hergestellt"), and a tool meant for a view only is not a
// tool at all: not listed, refused like an unknown tool, never forwarded.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { dbAll, uniq } from '../support/db.js';
import { runOAuthFlow } from '../support/mcpClient.js';
import { callTool, connectedUpstream, fakeControl, fakeState, listTools, mcp } from '../support/upstream.js';

test.use({ extraHTTPHeaders: {} });

let userN = 0;
const freshUser = (prefix: string): Record<string, string> => ({
  'Remote-User': `${prefix}-${Date.now().toString(36)}${(++userN).toString(36)}`,
  'Remote-Name': `Apps ${prefix}`,
});
/** MSG.unknownTool (apps/api/src/lib/proxyText.ts), exact. */
const unknownText = (name: string) => `[xitl] Verweigert: Das Tool „${name}“ ist nicht bekannt. / Denied: unknown tool "${name}". List the tools first.`;

const VIEW = 'ui://fake/dashboard.html';

/** An upstream (default ALLOW) offering a tool with a view, a view-only tool
 * and a tool with an unrelated `_meta` key; one OAuth client. */
async function setup(request: APIRequestContext, prefix: string) {
  const user = freshUser(prefix);
  const up = await connectedUpstream(request, prefix, { defaultPolicy: 'ALLOW', name: uniq(`Apps ${prefix}`) }, user, async (tenant) => {
    await fakeControl(request, tenant, 'tools', {
      name: 'show_memory',
      description: 'Memory usage with a chart.',
      _meta: { ui: { resourceUri: VIEW }, 'ui/resourceUri': VIEW, 'example.com/keep': 'yes' },
    });
    await fakeControl(request, tenant, 'tools', {
      name: 'refresh_chart',
      description: 'Called by the chart view only.',
      _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } },
    });
    await fakeControl(request, tenant, 'tools', {
      name: 'both_ways',
      description: 'Model and view.',
      _meta: { ui: { resourceUri: VIEW, visibility: ['model', 'app'] } },
    });
  });
  const c = await runOAuthFlow(request, uniq(`${prefix} client`), user);
  return { user, up, token: c.accessToken };
}

test.describe('MCP Apps slice 1 (ADR-0038)', () => {
  test('TC-240: tools/list carries no view reference, on /mcp/<slug> and /mcp; other _meta keys stay', async ({ request }) => {
    const ctx = await setup(request, 'apps240');
    for (const [slug, prefix] of [[ctx.up.slug, ''], [null, `${ctx.up.slug}_`]] as const) {
      const tools = (await mcp(request, slug, ctx.token, 'tools/list')).result.tools as { name: string; _meta?: Record<string, unknown> }[];
      const byName = new Map(tools.map((t) => [t.name, t]));
      const show = byName.get(`${prefix}show_memory`)!;
      expect(show).toBeTruthy();
      expect(show._meta).toEqual({ 'example.com/keep': 'yes' });
      const both = byName.get(`${prefix}both_ways`)!;
      expect(both).toBeTruthy();
      expect(both._meta).toBeUndefined();
      expect(JSON.stringify(tools)).not.toContain('ui://');
    }
    // No resources are advertised (only tools).
    const init = await mcp(request, ctx.up.slug, ctx.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    expect(Object.keys(init.result.capabilities)).not.toContain('resources');
  });

  test('TC-241: a view-only tool is not listed and not recorded', async ({ request }) => {
    const ctx = await setup(request, 'apps241');
    expect((await listTools(request, ctx.up.slug, ctx.token)).map((t) => t.name)).not.toContain('refresh_chart');
    expect((await listTools(request, null, ctx.token)).map((t) => t.name)).not.toContain(`${ctx.up.slug}_refresh_chart`);
    expect(dbAll('select name from KnownTool where upstreamId = ? and name = ?', ctx.up.id, 'refresh_chart')).toHaveLength(0);
  });

  test('TC-242: calling a view-only tool is refused as unknown and never forwarded, even with default ALLOW', async ({ request }) => {
    const ctx = await setup(request, 'apps242');
    await listTools(request, ctx.up.slug, ctx.token);
    for (const [slug, name] of [[ctx.up.slug, 'refresh_chart'], [null, `${ctx.up.slug}_refresh_chart`]] as const) {
      const r = await callTool(request, slug, ctx.token, name);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe(unknownText(name));
    }
    expect((await fakeState(request, ctx.up.tenant)).calls.refresh_chart ?? 0).toBe(0);
    // The tool with a view still works normally (text only).
    const ok = await callTool(request, ctx.up.slug, ctx.token, 'show_memory');
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0]!.text).toBe('ok:show_memory');
  });
});
