// The MCP server behind `/mcp/<slug>`: the proxy core (ADR-0004, ADR-0008,
// ADR-0014). Per request (stateless, like the handler in mount.ts) it:
// - initialize: answers with the upstream's own instructions (fetched live
//   when the upstream is usable, else the last seen ones / the description),
//   prefixed by one line saying this is xitl. Only the `tools` capability is
//   advertised: resources and prompts are not proxied (yet).
// - tools/list: fetches the upstream's list, records it (KnownTool), applies
//   the policy for THIS client: DENY tools are dropped, ASK tools get the
//   approval stamp in their description; name/inputSchema/annotations pass
//   through unchanged.
// - tools/call: re-evaluates the policy (never trusts that the client saw the
//   list), writes the audit row FIRST (PENDING), then forwards (ALLOW) or
//   refuses (DENY, and ASK until approval exists: "ask:no-channel").
//
// WHO is acting and WHICH upstream comes only from `AuthInfo.extra`, which
// mcp/verifier.ts (user, client) and mcp/mount.ts (upstream, resolved among
// that user's own upstreams) fill after the token is verified - never from
// anything the caller sends. Every query below is scoped by that userId.
import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { evaluatePolicy, type Policy } from '../lib/policy.js';
import { MSG, errorResult, instructionsFor, resultExcerpt, scrubSecrets, stampedDescription } from '../lib/proxyText.js';
import { CONNECT_TIMEOUT_MS, CALL_TIMEOUT_MS, UpstreamNeedsReconnect, UpstreamNotConnected, isUsable, withUpstream } from '../upstream/connection.js';
import { syncKnownTools, usableTools } from '../upstream/tools.js';
import { errorTag } from '../upstream/oauthClient.js';

/** What the proxy needs to know about one request, from the verified token and
 * the resolved upstream. */
export interface McpCallContext {
  userId: number;
  mcpClientId: number;
  clientName: string;
  upstream: { id: number; slug: string; name: string; description: string | null };
  /** mount.ts peeked: this request is `initialize` / `server/discover`. */
  wantsInstructions: boolean;
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
    wantsInstructions: extra.wantsInstructions === true,
  };
}

const INSTRUCTIONS_TIMEOUT_MS = 10_000;
const MAX_TOOL_NAME_IN_AUDIT = 200;

/** Generic, internals-free JSON-RPC error for a failed upstream list. */
function upstreamListError(name: string, e: unknown): ProtocolError {
  const text = e instanceof UpstreamNeedsReconnect ? MSG.reconnect(name) : e instanceof UpstreamNotConnected ? MSG.notConnected(name) : MSG.upstreamError(name);
  return new ProtocolError(ProtocolErrorCode.InternalError, text);
}

export function makeBuildMcpServer(clock: Clock = systemClock) {
  return async function buildMcpServer(ctx: McpRequestContext): Promise<Server> {
    const call = callContextFrom(ctx);
    const { userId, mcpClientId } = call;
    const [upstream, user] = await Promise.all([
      prisma.upstream.findFirst({ where: { id: call.upstream.id, userId } }),
      prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
    ]);
    if (!upstream || !user) throw new Error('upstream or user vanished mid-request');
    const endpoint = `/mcp/${upstream.slug}`;

    let upstreamInstructions = upstream.instructions;
    if (call.wantsInstructions && isUsable(upstream)) {
      try {
        // withUpstream stores the (length-capped) instructions; read them back.
        await withUpstream(upstream.id, userId, async () => undefined, {
          clock,
          timeoutMs: INSTRUCTIONS_TIMEOUT_MS,
        });
        upstreamInstructions =
          (await prisma.upstream.findFirst({ where: { id: upstream.id, userId }, select: { instructions: true } }))?.instructions ?? null;
      } catch (e) {
        console.warn(`proxy: upstream ${upstream.id}: instructions unavailable: ${errorTag(e)}`);
      }
    }

    const server = new Server(
      { name: `xitl/${upstream.slug}`, version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions: instructionsFor(upstreamInstructions, upstream.description?.trim() || upstream.name),
      },
    );

    server.setRequestHandler('tools/list', async () => {
      // Not connected yet: nothing to offer, and nothing to contact.
      if (!isUsable(upstream)) return { tools: [] };
      let tools: Tool[];
      try {
        tools = await withUpstream(
          upstream.id,
          userId,
          async ({ client }) => (await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS * 2 })).tools,
          { clock, timeoutMs: CONNECT_TIMEOUT_MS * 2 },
        );
      } catch (e) {
        console.warn(`proxy: upstream ${upstream.id}: tools/list failed: ${errorTag(e)}`);
        throw upstreamListError(upstream.name, e);
      }
      await syncKnownTools(upstream.id, tools, clock);
      const [known, current] = await Promise.all([
        prisma.knownTool.findMany({
          where: { upstreamId: upstream.id, upstream: { userId } },
          include: { clientPolicies: { where: { mcpClientId } } },
        }),
        // The default may have changed since the factory ran; read it fresh.
        prisma.upstream.findFirst({ where: { id: upstream.id, userId }, select: { defaultPolicy: true } }),
      ]);
      const byName = new Map(known.map((k) => [k.name, k]));
      const listed: Tool[] = [];
      for (const t of usableTools(tools)) {
        const k = byName.get(t.name);
        const decision = evaluatePolicy({
          upstreamDefault: (current?.defaultPolicy ?? 'DENY') as Policy,
          tool: k ? { policy: k.policy as Policy | null, acknowledgedAt: k.acknowledgedAt } : null,
          clientOverride: (k?.clientPolicies[0]?.policy as Policy | undefined) ?? null,
        });
        if (decision.policy === 'DENY') continue;
        listed.push(decision.policy === 'ASK' ? { ...t, description: stampedDescription(t.description, user.displayName) } : t);
      }
      return { tools: listed };
    });

    server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const receivedAt = clock.now();

      // Fresh reads: policy state at call time, scoped by the token's user.
      const [tool, current] = await Promise.all([
        prisma.knownTool.findFirst({
          where: { upstreamId: upstream.id, name, upstream: { userId } },
          include: { clientPolicies: { where: { mcpClientId } } },
        }),
        prisma.upstream.findFirst({ where: { id: upstream.id, userId }, select: { defaultPolicy: true } }),
      ]);
      if (!current) throw new Error('upstream vanished mid-request');
      const decision = evaluatePolicy({
        upstreamDefault: current.defaultPolicy as Policy,
        tool: tool ? { policy: tool.policy as Policy | null, acknowledgedAt: tool.acknowledgedAt } : null,
        clientOverride: (tool?.clientPolicies[0]?.policy as Policy | undefined) ?? null,
      });

      // Audit first (ADR-0008): if this write fails, nothing is forwarded.
      const audit = await prisma.auditEntry.create({
        data: {
          userId,
          mcpClientId,
          upstreamId: upstream.id,
          endpoint,
          toolName: name.slice(0, MAX_TOOL_NAME_IN_AUDIT),
          arguments: JSON.stringify(args),
          policy: decision.policy,
          decisionPath: decision.path,
          outcome: 'PENDING',
          receivedAt,
        },
      });
      const shownName = name.slice(0, 100);
      const finish = (data: { outcome: 'FORWARDED' | 'DENIED' | 'UPSTREAM_ERROR'; decisionPath?: string; isError?: boolean; resultText?: string; decided?: boolean }) =>
        prisma.auditEntry.update({
          where: { id: audit.id },
          data: {
            outcome: data.outcome,
            ...(data.decisionPath ? { decisionPath: data.decisionPath } : {}),
            isError: data.isError ?? null,
            resultText: data.resultText ?? null,
            decidedAt: receivedAt,
            finishedAt: clock.now(),
          },
        });

      if (decision.policy === 'DENY') {
        const text = decision.path === 'unknown-tool' ? MSG.unknownTool(shownName) : MSG.denied(shownName);
        await finish({ outcome: 'DENIED', isError: true, resultText: text });
        return errorResult(text);
      }

      if (decision.policy === 'ASK') {
        // SLICE 6 replaces this: hold the call, notify the user (push/page),
        // wait up to 300 s, deny on timeout (ADR-0004). Until then: fail closed.
        const text = MSG.askUnavailable(shownName);
        await finish({ outcome: 'DENIED', decisionPath: `${decision.path}+ask:no-channel`, isError: true, resultText: text });
        return errorResult(text);
      }

      // ALLOW: forward.
      try {
        const result = await withUpstream(
          upstream.id,
          userId,
          async ({ client, secrets }) =>
            scrubSecrets((await client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS })) as CallToolResult, secrets()),
          { clock, timeoutMs: CALL_TIMEOUT_MS },
        );
        await finish({ outcome: 'FORWARDED', isError: result.isError === true, resultText: resultExcerpt(result) });
        return result;
      } catch (e) {
        const text =
          e instanceof UpstreamNeedsReconnect
            ? MSG.reconnect(upstream.name)
            : e instanceof UpstreamNotConnected
              ? MSG.notConnected(upstream.name)
              : MSG.upstreamError(upstream.name);
        console.warn(`proxy: upstream ${upstream.id}: tools/call failed: ${errorTag(e)}`);
        await finish({ outcome: 'UPSTREAM_ERROR', isError: true, resultText: text });
        return errorResult(text);
      }
    });

    return server;
  };
}

export const buildMcpServer = makeBuildMcpServer();
