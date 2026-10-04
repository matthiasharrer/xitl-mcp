// STUB: the MCP server behind `/mcp/<slug>`. The proxy core (forwarding the
// upstream's tools through the policy engine, ADR-0004/0014) replaces this in a
// later slice. Until then every upstream answers `initialize` and `tools/list`
// (empty) so the OAuth flow and the endpoint routing can be exercised end to end.
//
// buildMcpServer is the per-request factory `createMcpHandler` calls per
// exchange (as in haushalts-todos' mcp/server.ts): nothing here holds state
// across calls.
//
// WHO is acting and WHICH upstream comes only from `AuthInfo.extra`, which
// mcp/verifier.ts (user, client) and mcp/mount.ts (upstream, resolved among
// that user's own upstreams) fill after the token is verified - never from
// anything the caller sends.
import { McpServer } from '@modelcontextprotocol/server';
import type { McpRequestContext } from '@modelcontextprotocol/server';

/** What the proxy needs to know about one request, from the verified token and
 * the resolved upstream. */
export interface McpCallContext {
  userId: number;
  mcpClientId: number;
  clientName: string;
  upstream: { id: number; slug: string; name: string; description: string | null };
}

/** Reads the call context out of `AuthInfo.extra`. Fails closed. */
export function callContextFrom(ctx: McpRequestContext): McpCallContext {
  const extra = ctx.authInfo?.extra;
  const upstream = extra?.upstream as McpCallContext['upstream'] | undefined;
  if (
    typeof extra?.userId !== 'number' ||
    typeof extra?.mcpClientId !== 'number' ||
    typeof extra?.clientName !== 'string' ||
    !upstream ||
    typeof upstream.id !== 'number' ||
    typeof upstream.slug !== 'string'
  ) {
    throw new Error('MCP request without a verified user/upstream binding');
  }
  return {
    userId: extra.userId,
    mcpClientId: extra.mcpClientId,
    clientName: extra.clientName,
    upstream,
  };
}

export function buildMcpServer(ctx: McpRequestContext): McpServer {
  const call = callContextFrom(ctx);
  const instructions = call.upstream.description?.trim() || call.upstream.name;
  const server = new McpServer({ name: `xitl/${call.upstream.slug}`, version: '0.0.0' }, { instructions });
  // No tools yet: the proxy core registers the upstream's tools here (with
  // registerTool, which sets up the tools capability and handlers itself). Until
  // then, declare the capability and answer tools/list with an empty list, so a
  // client sees a normal tool-less server instead of "Method not found".
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler('tools/list', () => ({ tools: [] }));
  return server;
}
