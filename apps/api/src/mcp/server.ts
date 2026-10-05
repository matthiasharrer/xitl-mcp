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
//   list; a live snooze can turn ASK into ALLOW), writes the audit row FIRST
//   (PENDING), then forwards (ALLOW), refuses (DENY) or holds the call for the
//   user's decision (ASK, approval/pending.ts): approve -> forward with what is
//   left of the 300 s budget; deny / timeout / client abort / shutdown -> refuse.
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
import { awaitingReview, evaluatePolicy, type Policy, type PolicyTool } from '../lib/policy.js';
import { MSG, errorResult, instructionsFor, resultExcerpt, scrubSecrets, stampedDescription } from '../lib/proxyText.js';
import { CONNECT_TIMEOUT_MS, CALL_TIMEOUT_MS, UpstreamNeedsReconnect, UpstreamNotConnected, isUsable, withUpstream } from '../upstream/connection.js';
import { syncKnownTools, usableTools } from '../upstream/tools.js';
import { errorTag } from '../upstream/oauthClient.js';
import { approvals, ApprovalHub, type Decision } from '../approval/pending.js';
import { approvalDeadline, approvalTimeoutFromEnv, upstreamTimeoutMs } from '../approval/budget.js';
import { createSnooze, liveSnoozeUntil, liveSnoozesFor } from '../approval/snooze.js';

/** What the proxy needs to know about one request, from the verified token and
 * the resolved upstream. */
export interface McpCallContext {
  userId: number;
  mcpClientId: number;
  clientName: string;
  upstream: { id: number; slug: string; name: string; description: string | null };
  /** mount.ts peeked: this request is `initialize` / `server/discover`. */
  wantsInstructions: boolean;
  /** The caller's own MCP session (ADR-0016), checked by mount.ts; null when
   * sessionless. Diagnostics/grouping only, never authority. */
  session: { id: string; createdAt: Date } | null;
}

function sessionFrom(raw: unknown): McpCallContext['session'] {
  const s = raw as { id?: unknown; createdAt?: unknown } | null | undefined;
  if (!s || typeof s.id !== 'string' || typeof s.createdAt !== 'string') return null;
  const createdAt = new Date(s.createdAt);
  return Number.isNaN(createdAt.getTime()) ? null : { id: s.id, createdAt };
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
    session: sessionFrom(extra.session),
  };
}

const INSTRUCTIONS_TIMEOUT_MS = 10_000;
const MAX_TOOL_NAME_IN_AUDIT = 200;

/** Generic, internals-free JSON-RPC error for a failed upstream list. */
function upstreamListError(name: string, e: unknown): ProtocolError {
  const text = e instanceof UpstreamNeedsReconnect ? MSG.reconnect(name) : e instanceof UpstreamNotConnected ? MSG.notConnected(name) : MSG.upstreamError(name);
  return new ProtocolError(ProtocolErrorCode.InternalError, text);
}

/** The KnownTool fields the policy engine needs. */
function policyTool(k: { policy: string | null; acknowledgedAt: Date | null; changedAt: Date | null }): PolicyTool {
  return { policy: k.policy as Policy | null, acknowledgedAt: k.acknowledgedAt, changedAt: k.changedAt };
}

export interface ProxyDeps {
  clock?: Clock;
  hub?: ApprovalHub;
  /** How long an ASK call waits for a decision (capped by the 300 s budget). */
  approvalTimeoutMs?: number;
}

export function makeBuildMcpServer(deps: ProxyDeps = {}) {
  const clock = deps.clock ?? systemClock;
  const hub = deps.hub ?? approvals;
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? approvalTimeoutFromEnv(process.env.APPROVAL_TIMEOUT_MS);
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
          // Scrubbed: an upstream could echo our credential in a description.
          async ({ client, secrets }) => scrubSecrets((await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS * 2 })).tools, secrets()),
          { clock, timeoutMs: CONNECT_TIMEOUT_MS * 2 },
        );
      } catch (e) {
        console.warn(`proxy: upstream ${upstream.id}: tools/list failed: ${errorTag(e)}`);
        throw upstreamListError(upstream.name, e);
      }
      await syncKnownTools(upstream.id, tools, clock);
      const now = clock.now();
      const [known, current, snoozes] = await Promise.all([
        prisma.knownTool.findMany({
          where: { upstreamId: upstream.id, upstream: { userId } },
          include: { clientPolicies: { where: { mcpClientId } } },
        }),
        // The default may have changed since the factory ran; read it fresh.
        prisma.upstream.findFirst({ where: { id: upstream.id, userId }, select: { defaultPolicy: true } }),
        liveSnoozesFor(userId, upstream.id, mcpClientId, now),
      ]);
      const byName = new Map(known.map((k) => [k.name, k]));
      const listed: Tool[] = [];
      for (const t of usableTools(tools)) {
        const k = byName.get(t.name);
        const decision = evaluatePolicy({
          upstreamDefault: (current?.defaultPolicy ?? 'DENY') as Policy,
          tool: k ? policyTool(k) : null,
          clientOverride: (k?.clientPolicies[0]?.policy as Policy | undefined) ?? null,
          snoozedUntil: snoozes.get(t.name) ?? null,
          now,
        });
        if (decision.policy === 'DENY') continue;
        listed.push(decision.policy === 'ASK' ? { ...t, description: stampedDescription(t.description, user.displayName) } : t);
      }
      return { tools: listed };
    });

    server.setRequestHandler('tools/call', async (request, reqCtx): Promise<CallToolResult> => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      // The 300 s budget (TC-37) counts from here.
      const receivedAt = clock.now();
      const signal = reqCtx.mcpReq.signal;

      // Fresh reads: policy state at call time, scoped by the token's user.
      const [tool, current, snoozedUntil] = await Promise.all([
        prisma.knownTool.findFirst({
          where: { upstreamId: upstream.id, name, upstream: { userId } },
          include: { clientPolicies: { where: { mcpClientId } } },
        }),
        prisma.upstream.findFirst({ where: { id: upstream.id, userId }, select: { defaultPolicy: true } }),
        liveSnoozeUntil({ userId, upstreamId: upstream.id, toolName: name, mcpClientId }, receivedAt),
      ]);
      if (!current) throw new Error('upstream vanished mid-request');
      const toolState = tool ? policyTool(tool) : null;
      const decision = evaluatePolicy({
        upstreamDefault: current.defaultPolicy as Policy,
        tool: toolState,
        clientOverride: (tool?.clientPolicies[0]?.policy as Policy | undefined) ?? null,
        snoozedUntil,
        now: receivedAt,
      });
      // ASK: the id the user decides by. Written into the audit row first, so a
      // late decision can be told apart (409) from a foreign/unknown id (404).
      const approvalId = decision.policy === 'ASK' ? ApprovalHub.newId() : null;

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
          approvalId,
          sessionId: call.session?.id ?? null,
        },
      });
      const shownName = name.slice(0, 100);
      const finish = (data: {
        outcome: 'FORWARDED' | 'DENIED' | 'TIMED_OUT' | 'UPSTREAM_ERROR';
        decisionPath?: string;
        isError?: boolean;
        resultText?: string;
        decidedAt?: Date;
      }) =>
        prisma.auditEntry.update({
          where: { id: audit.id },
          data: {
            outcome: data.outcome,
            ...(data.decisionPath ? { decisionPath: data.decisionPath } : {}),
            isError: data.isError ?? null,
            resultText: data.resultText ?? null,
            decidedAt: data.decidedAt ?? receivedAt,
            finishedAt: clock.now(),
          },
        });

      /** Calls the upstream; the ONLY place a call leaves xitl. */
      const forward = async (timeoutMs: number, decisionPath?: string, decidedAt?: Date): Promise<CallToolResult> => {
        try {
          const result = await withUpstream(
            upstream.id,
            userId,
            async ({ client, secrets }) =>
              scrubSecrets((await client.callTool({ name, arguments: args }, { timeout: timeoutMs })) as CallToolResult, secrets()),
            { clock, timeoutMs },
          );
          await finish({ outcome: 'FORWARDED', decisionPath, decidedAt, isError: result.isError === true, resultText: resultExcerpt(result) });
          return result;
        } catch (e) {
          const text =
            e instanceof UpstreamNeedsReconnect
              ? MSG.reconnect(upstream.name)
              : e instanceof UpstreamNotConnected
                ? MSG.notConnected(upstream.name)
                : MSG.upstreamError(upstream.name);
          console.warn(`proxy: upstream ${upstream.id}: tools/call failed: ${errorTag(e)}`);
          await finish({ outcome: 'UPSTREAM_ERROR', decisionPath, decidedAt, isError: true, resultText: text });
          return errorResult(text);
        }
      };

      if (decision.policy === 'DENY') {
        const text = decision.path === 'unknown-tool' ? MSG.unknownTool(shownName) : MSG.denied(shownName);
        await finish({ outcome: 'DENIED', isError: true, resultText: text });
        return errorResult(text);
      }

      if (decision.policy === 'ASK' && approvalId) {
        const rule = decision.path;
        const held = hub.hold(
          {
            userId,
            mcpClientId,
            clientName: call.clientName,
            upstreamId: upstream.id,
            upstreamSlug: upstream.slug,
            upstreamName: upstream.name,
            toolName: name.slice(0, MAX_TOOL_NAME_IN_AUDIT),
            args,
            auditId: audit.id,
            rulePath: rule,
            receivedAt,
            deadline: approvalDeadline(receivedAt, approvalTimeoutMs),
            // New/changed tools are reviewed in the rules, not snoozed (policy.ts).
            snoozable: !awaitingReview(toolState),
            session: call.session,
          },
          approvalId,
        );
        // The client hanging up is a denial, never a reason to keep waiting.
        const onAbort = () => hub.abort(approvalId);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        let d: Decision;
        try {
          d = await held.decision;
        } finally {
          signal.removeEventListener('abort', onAbort);
        }

        if (d.kind === 'approve') {
          const path = `${rule}+approved:${d.via}`;
          // Revocation settles held calls (cancelWhere), but a call that was
          // between evaluation and hold() at that moment could still be held
          // afterwards. Re-check the client binding before anything leaves.
          const stillBound = await prisma.mcpClient.findFirst({ where: { id: mcpClientId, userId }, select: { id: true } });
          if (!stillBound) {
            const text = MSG.revoked(shownName);
            await finish({ outcome: 'DENIED', decisionPath: `${rule}+revoked`, decidedAt: d.at, isError: true, resultText: text });
            return errorResult(text);
          }
          if (d.snoozeUntil && held.call.snoozable) {
            try {
              await createSnooze({ userId, upstreamId: upstream.id, toolName: name, mcpClientId }, d.snoozeUntil, d.at);
            } catch (e) {
              console.warn(`proxy: snooze not stored: ${errorTag(e)}`);
            }
          }
          const timeoutMs = upstreamTimeoutMs(receivedAt, clock.now(), CALL_TIMEOUT_MS);
          if (timeoutMs === null) {
            const text = MSG.timedOut(shownName);
            await finish({ outcome: 'TIMED_OUT', decisionPath: `${path}+timeout`, decidedAt: d.at, isError: true, resultText: text });
            return errorResult(text);
          }
          return forward(timeoutMs, path, d.at);
        }
        if (d.kind === 'deny') {
          const text = MSG.declined(shownName, user.displayName);
          await finish({ outcome: 'DENIED', decisionPath: `${rule}+denied:${d.via}`, decidedAt: d.at, isError: true, resultText: text });
          return errorResult(text);
        }
        if (d.kind === 'timeout') {
          const text = MSG.timedOut(shownName);
          await finish({ outcome: 'TIMED_OUT', decisionPath: `${rule}+timeout`, decidedAt: d.at, isError: true, resultText: text });
          return errorResult(text);
        }
        // aborted / shutdown / revoked / flood: fail closed.
        const text =
          d.kind === 'flood' ? MSG.flood(shownName) : d.kind === 'revoked' ? MSG.revoked(shownName) : MSG.approvalCancelled(shownName);
        await finish({ outcome: 'DENIED', decisionPath: `${rule}+${d.kind}`, decidedAt: d.at, isError: true, resultText: text });
        return errorResult(text);
      }

      if (decision.policy !== 'ALLOW') {
        // Unreachable (evaluatePolicy only returns the three Policy values);
        // fail closed rather than forward on anything unexpected.
        const text = MSG.denied(shownName);
        await finish({ outcome: 'DENIED', isError: true, resultText: text });
        return errorResult(text);
      }

      // ALLOW (rule or snooze): forward.
      return forward(CALL_TIMEOUT_MS);
    });

    return server;
  };
}

export const buildMcpServer = makeBuildMcpServer();
