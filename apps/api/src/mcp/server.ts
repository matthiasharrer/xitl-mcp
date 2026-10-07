// The MCP servers behind `/mcp/<slug>` and `/mcp`: the proxy core (ADR-0004,
// ADR-0008, ADR-0014, ADR-0017). Per request (stateless, like the handler in
// mount.ts) it:
// - initialize: answers with instructions. `/mcp/<slug>`: the upstream's own
//   (fetched live when the upstream is usable, else the last seen ones / the
//   description), prefixed by one line saying this is xitl. `/mcp`: generated,
//   one section per upstream with its state line (proxyText.unifiedInstructions,
//   ADR-0022: the live contact decides, else the stored state). Only the `tools`
//   capability is advertised: resources and prompts are not proxied (yet).
// - tools/list: fetches the upstream's list, records it (KnownTool), applies
//   the policy for THIS client: DENY tools are dropped, ASK tools get the
//   approval stamp in their description; name/inputSchema/annotations pass
//   through unchanged. `/mcp` does this for every usable upstream in parallel,
//   prefixes the names `<slug>_` and leaves out an upstream that fails
//   (ADR-0017 degrade). No tool is added for a failing upstream: the user is
//   told by push and on Freigaben (ADR-0022, upstream/stateEvents.ts), the
//   agent only by the state line in the instructions.
// - tools/call: re-evaluates the policy (never trusts that the client saw the
//   list; a live allow pause can turn ASK into ALLOW, a live deny pause
//   refuses at once, ADR-0026), writes the audit row FIRST
//   (PENDING), then forwards (ALLOW), refuses (DENY) or holds the call for the
//   user's decision (ASK, approval/pending.ts): approve -> forward with what is
//   left of the 300 s budget; deny / timeout / client abort / shutdown -> refuse.
//   Every call is also queued for its advisory intent summary (ADR-0025,
//   intent/queue.ts): fire-and-forget, never awaited, never read back here.
//   `/mcp` first splits the name (lib/unifiedNames.ts) and resolves the slug
//   among the user's own upstreams; anything unresolved is denied and audited.
//   Both endpoints then take the same path (callTool), so rules, snoozes and
//   approvals are one set per user.
//
// WHO is acting and WHICH upstream comes only from `AuthInfo.extra`, which
// mcp/verifier.ts (user, client) and mcp/mount.ts (upstream, resolved among
// that user's own upstreams, or the `unified` marker) fill after the token is
// verified - never from anything the caller sends. Every query below is scoped
// by that userId.
import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { awaitingReview, evaluatePolicy, type Policy, type PolicyTool } from '../lib/policy.js';
import {
  MSG,
  errorResult,
  instructionsFor,
  resultExcerpt,
  scrubSecrets,
  stampedDescription,
  unifiedInstructions,
  type UpstreamState,
} from '../lib/proxyText.js';
import { splitUnifiedName, unifiedName } from '../lib/unifiedNames.js';
import { CONNECT_TIMEOUT_MS, CALL_TIMEOUT_MS, UpstreamNeedsReconnect, UpstreamNotConnected, isUsable, storedState, withUpstream } from '../upstream/connection.js';
import { syncKnownTools, usableTools } from '../upstream/tools.js';
import { errorTag } from '../upstream/oauthClient.js';
import { approvals, ApprovalHub, type Decision } from '../approval/pending.js';
import { approvalDeadline, approvalTimeoutFromEnv, upstreamTimeoutMs } from '../approval/budget.js';
import { createSnooze, heldCoveredBy, isReadOnly, livePauses, liveSnoozesFor, type MatchedAllowPause, type SnoozeScope } from '../approval/snooze.js';
import type { PendingCall } from '../approval/pending.js';
import { pauseGate as defaultPauseGate, sperreGate as defaultSperreGate } from '../pausecheck/index.js';
import { relaxSperre, SperreGate, type SperreResult } from '../pausecheck/sperre.js';
import { narrow, type GateResult, type PauseGate } from '../pausecheck/gate.js';
import { autoGate as defaultAutoGate } from '../auto/index.js';
import { resolveAuto, type AutoGate, type AutoResult } from '../auto/gate.js';
import type { AutoCheckView } from '../auto/text.js';
import type { PauseCheckView } from '../pausecheck/text.js';
import type { Upstream } from '../generated/prisma/client.js';
import { intents as defaultIntents } from '../intent/index.js';
import { NO_INTENT, type IntentQueue } from '../intent/queue.js';
import { sourceKey } from '../intent/group.js';
import { auditEvents } from '../lib/auditEvents.js';
import { hintOfRow, type HintRow } from '../toolhint/hint.js';
import type { RequestDiagnostics } from './sessions.js';

/** The running build (CI sets APP_VERSION: `0.3.1`, `main`); MCP serverInfo. */
const APP_VERSION = process.env.APP_VERSION ?? 'dev';

export const UNIFIED_ENDPOINT = '/mcp';

export interface UpstreamRef {
  id: number;
  slug: string;
  name: string;
  description: string | null;
}

/** What the proxy needs to know about one request, from the verified token and
 * the resolved upstream. */
export interface McpCallContext {
  userId: number;
  mcpClientId: number;
  clientName: string;
  /** The one upstream of `/mcp/<slug>`; null on the unified `/mcp`. */
  upstream: UpstreamRef | null;
  /** mount.ts peeked: this request is `initialize` / `server/discover`. */
  wantsInstructions: boolean;
  /** The caller's own MCP session (ADR-0016), checked by mount.ts; null when
   * sessionless. Diagnostics/grouping only, never authority. */
  session: { id: string; createdAt: Date } | null;
  /** What this request said about its client (mount.ts); null if absent. */
  diagnostics: RequestDiagnostics | null;
}

function sessionFrom(raw: unknown): McpCallContext['session'] {
  const s = raw as { id?: unknown; createdAt?: unknown } | null | undefined;
  if (!s || typeof s.id !== 'string' || typeof s.createdAt !== 'string') return null;
  const createdAt = new Date(s.createdAt);
  return Number.isNaN(createdAt.getTime()) ? null : { id: s.id, createdAt };
}

function diagnosticsFrom(raw: unknown): RequestDiagnostics | null {
  const d = raw as Partial<RequestDiagnostics> | null | undefined;
  if (!d || !Array.isArray(d.headerNames) || !Array.isArray(d.metaKeys)) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    protocolVersion: str(d.protocolVersion),
    clientName: str(d.clientName),
    clientVersion: str(d.clientVersion),
    userAgent: str(d.userAgent),
    headerNames: d.headerNames.filter((n): n is string => typeof n === 'string'),
    metaKeys: d.metaKeys.filter((n): n is string => typeof n === 'string'),
    traceId: str(d.traceId),
    cloudTraceId: str(d.cloudTraceId),
    anthropicClient: str(d.anthropicClient),
  };
}

/** The audit row's diagnostics columns (ADR-0016 measurement). */
function auditDiagnostics(d: RequestDiagnostics | null) {
  if (!d) return {};
  const info = [d.clientName, d.clientVersion].filter(Boolean).join(' ');
  return {
    protocolVersion: d.protocolVersion,
    clientInfo: info || null,
    userAgent: d.userAgent,
    headerNames: JSON.stringify(d.headerNames),
    metaKeys: JSON.stringify(d.metaKeys),
    traceId: d.traceId,
    cloudTraceId: d.cloudTraceId,
    anthropicClient: d.anthropicClient,
  };
}

/** Reads the call context out of `AuthInfo.extra`. Fails closed. */
export function callContextFrom(ctx: McpRequestContext): McpCallContext {
  const extra = ctx.authInfo?.extra;
  const upstream = extra?.upstream as UpstreamRef | null | undefined;
  // Exactly one of: a resolved upstream (`/mcp/<slug>`), or the explicit
  // unified marker (`/mcp`). Anything else is a wiring bug: fail closed.
  const single = !!upstream && typeof upstream.id === 'number' && typeof upstream.slug === 'string';
  const unified = extra?.unified === true && upstream == null;
  if (
    typeof extra?.userId !== 'number' ||
    typeof extra?.mcpClientId !== 'number' ||
    typeof extra?.clientName !== 'string' ||
    single === unified
  ) {
    throw new Error('MCP request without a verified user/upstream binding');
  }
  return {
    userId: extra.userId,
    mcpClientId: extra.mcpClientId,
    clientName: extra.clientName,
    upstream: single ? upstream! : null,
    wantsInstructions: extra.wantsInstructions === true,
    session: sessionFrom(extra.session),
    diagnostics: diagnosticsFrom(extra.diagnostics),
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

function parseAnnotations(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** ADR-0031: what the Freigaben card shows about a new/changed tool. */
function reviewOf(row: HintRow): { attention: boolean; reasons: string[]; label: string | null } {
  const h = hintOfRow(row);
  return { attention: h.attention, reasons: h.reasons, label: h.label };
}

export interface ProxyDeps {
  clock?: Clock;
  hub?: ApprovalHub;
  /** How long an ASK call waits for a decision (capped by the 300 s budget). */
  approvalTimeoutMs?: number;
  /** The advisory intent summary queue (ADR-0025). */
  intents?: IntentQueue;
  /** The AI check of allow pauses (ADR-0029). */
  pauseGate?: PauseGate;
  /** The AUTO check (ADR-0030). */
  autoGate?: AutoGate;
  /** The purpose check of a Sperre (ADR-0026 amendment). */
  sperreGate?: SperreGate;
}

/** What a held call shows about the AUTO check that asked it (ADR-0030). */
function autoView(r: AutoResult | null): AutoCheckView | undefined {
  if (r?.kind === 'below') return { result: 'below', score: r.score };
  if (r?.kind === 'error' || r?.kind === 'off' || r?.kind === 'norule') return { result: r.kind, score: null };
  return undefined;
}

/** What a held call shows about the AI check that sent it back (ADR-0029). */
function checkView(r: GateResult | null): PauseCheckView | undefined {
  if (r?.kind === 'mismatch') return { result: 'mismatch', choice: r.choice, score: r.score };
  if (r?.kind === 'error') return { result: 'error', choice: null, score: null };
  return undefined;
}

export function makeBuildMcpServer(deps: ProxyDeps = {}) {
  const clock = deps.clock ?? systemClock;
  const hub = deps.hub ?? approvals;
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? approvalTimeoutFromEnv(process.env.APPROVAL_TIMEOUT_MS);
  const intents = deps.intents ?? defaultIntents;
  const gate = deps.pauseGate ?? defaultPauseGate;
  const auto = deps.autoGate ?? defaultAutoGate;
  const sperre = deps.sperreGate ?? defaultSperreGate;

  /** ADR-0029 §6 (TC-145): a new allow pause settles the held calls it covers
   * (TC-128) through the same AI check, in order, under the access's serial
   * lock: a match (or a blind pause) is approved "via pause"; a mismatch ends
   * the pause and leaves that call and the rest held; an error leaves them
   * held (the pause stays). Only when the check is configured; without it
   * (and when the user's switch was off at decision time) the route settles
   * them at once as before (routes/approvals.ts). Never throws. */
  async function settleCovered(origin: PendingCall, scope: SnoozeScope, pause: MatchedAllowPause): Promise<void> {
    const { userId, mcpClientId, upstreamId } = origin;
    const covered = heldCoveredBy(origin, hub.list(userId), scope, 'ALLOW');
    if (covered.length === 0) return;
    await gate.serial(userId, mcpClientId, async () => {
      for (const other of covered) {
        if (!hub.get(userId, other.id)) continue;
        const live = await prisma.snooze.findFirst({ where: { id: pause.id, userId, until: { gt: clock.now() } }, select: { id: true } });
        if (!live) return; // ended meanwhile: the rest stay held
        const r = await gate.evaluate({
          userId,
          mcpClientId,
          upstreamId,
          pause,
          call: { upstream: other.upstreamName, tool: other.toolName, args: other.args },
        });
        const scored = r.kind === 'match' || r.kind === 'mismatch' ? { pauseCheckScore: r.score, pauseCheckChoice: r.choice, pausePurpose: pause.purpose ?? null, pausePurposeSource: pause.purpose ? (pause.purposeSource ?? 'typed') : null } : {};
        if (r.kind === 'blind' || r.kind === 'match') {
          await prisma.auditEntry.updateMany({ where: { id: other.auditId, userId }, data: { pauseSnoozeId: pause.id, ...scored } });
          auditEvents.emit({ userId, auditId: other.auditId });
          hub.decide(userId, other.id, { kind: 'approve', via: 'pause', snoozeUntil: null });
          continue;
        }
        if (r.kind === 'mismatch') {
          await prisma.auditEntry.updateMany({ where: { id: other.auditId, userId }, data: scored });
          auditEvents.emit({ userId, auditId: other.auditId });
        }
        hub.setPauseCheck(userId, other.id, checkView(r)!);
        return;
      }
    }).catch((e) => console.warn(`proxy: settling held calls by pause failed: ${errorTag(e)}`));
  }

  /** The upstream's instructions: fetched live when it is usable (withUpstream
   * stores the length-capped, scrubbed text; read back), else the stored ones.
   * `state` is what the live contact found (ADR-0022); stored when not usable. */
  async function liveInstructions(upstream: Upstream): Promise<{ instructions: string | null; state: UpstreamState }> {
    if (!isUsable(upstream)) return { instructions: upstream.instructions, state: storedState(upstream) };
    try {
      await withUpstream(upstream.id, upstream.userId, async () => undefined, { clock, timeoutMs: INSTRUCTIONS_TIMEOUT_MS });
      const row = await prisma.upstream.findFirst({ where: { id: upstream.id, userId: upstream.userId }, select: { instructions: true } });
      return { instructions: row?.instructions ?? null, state: 'ok' };
    } catch (e) {
      console.warn(`proxy: upstream ${upstream.id}: instructions unavailable: ${errorTag(e)}`);
      const state: UpstreamState = e instanceof UpstreamNeedsReconnect ? 'reconnect' : e instanceof UpstreamNotConnected ? 'not-connected' : 'unreachable';
      return { instructions: upstream.instructions, state };
    }
  }

  /** One upstream's tools as THIS client may see them: DENY dropped, ASK
   * stamped, names unchanged. [] when the upstream isn't usable; throws (a
   * ProtocolError with a generic text) when the upstream fails. */
  async function listFor(upstream: Upstream, mcpClientId: number, displayName: string): Promise<Tool[]> {
    const userId = upstream.userId;
    // Not connected yet: nothing to offer, and nothing to contact.
    if (!isUsable(upstream)) return [];
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
      liveSnoozesFor({ userId, upstreamId: upstream.id, mcpClientId }, now),
    ]);
    const byName = new Map(known.map((k) => [k.name, k]));
    const listed: Tool[] = [];
    for (const t of usableTools(tools)) {
      const k = byName.get(t.name);
      const decision = evaluatePolicy({
        upstreamDefault: (current?.defaultPolicy ?? 'DENY') as Policy,
        tool: k ? policyTool(k) : null,
        clientOverride: (k?.clientPolicies[0]?.policy as Policy | undefined) ?? null,
        snoozedUntil: snoozes(t.name, isReadOnly(k?.annotations)),
        now,
      });
      if (decision.policy === 'DENY') continue;
      // AUTO may be asked (ADR-0030): stamped like ASK. Only plain ALLOW is not.
      listed.push(decision.policy !== 'ALLOW' ? { ...t, description: stampedDescription(t.description, displayName) } : t);
    }
    return listed;
  }

  /** A `/mcp` call whose name resolves to no upstream of this user: denied
   * and audited (no upstream, the full name), nothing contacted. */
  async function denyUnresolved(call: McpCallContext, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const receivedAt = clock.now();
    const text = MSG.unknownTool(name.slice(0, 100));
    const created = await prisma.auditEntry.create({
      data: {
        userId: call.userId,
        mcpClientId: call.mcpClientId,
        upstreamId: null,
        endpoint: UNIFIED_ENDPOINT,
        toolName: name.slice(0, MAX_TOOL_NAME_IN_AUDIT),
        arguments: JSON.stringify(args),
        policy: 'DENY',
        decisionPath: 'unknown-tool',
        outcome: 'DENIED',
        isError: true,
        resultText: text,
        receivedAt,
        decidedAt: receivedAt,
        finishedAt: receivedAt,
        sessionId: call.session?.id ?? null,
        // No upstream, no tool to describe: nothing to summarize (ADR-0025).
        intentStatus: intents.enabled ? 'SKIPPED' : 'OFF',
        ...auditDiagnostics(call.diagnostics),
      },
    });
    auditEvents.emit({ userId: call.userId, auditId: created.id });
    return errorResult(text);
  }

  /** One `tools/call` to one of the user's upstreams, by the upstream's own
   * tool name: policy, audit, approval, forward. The same for both endpoints. */
  async function callTool(p: {
    call: McpCallContext;
    displayName: string;
    upstream: UpstreamRef;
    endpoint: string;
    name: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
    /** The JSON-RPC id of this tools/call (for `notifications/cancelled`). */
    rpcId: string | number;
  }): Promise<CallToolResult> {
    const { call, displayName, upstream, endpoint, name, args, signal, rpcId } = p;
    const { userId, mcpClientId } = call;
    // The 300 s budget (TC-37) counts from here.
    const receivedAt = clock.now();

    // Fresh reads: policy state at call time, scoped by the token's user.
    const [tool, current] = await Promise.all([
      prisma.knownTool.findFirst({
        where: { upstreamId: upstream.id, name, upstream: { userId } },
        include: { clientPolicies: { where: { mcpClientId } } },
      }),
      prisma.upstream.findFirst({ where: { id: upstream.id, userId }, select: { defaultPolicy: true, autoRule: true } }),
    ]);
    if (!current) throw new Error('upstream vanished mid-request');
    // Read-only by the STORED annotations (an unknown tool is not read-only).
    const readOnly = isReadOnly(tool?.annotations);
    const snoozeOwner = { userId, upstreamId: upstream.id, mcpClientId };
    const toolState = tool ? policyTool(tool) : null;
    // Allow and deny pauses of THIS client on THIS upstream (ADR-0004,
    // ADR-0026); a deny pause wins in the policy.
    const evaluate = async (now: Date) => {
      const pauses = await livePauses(snoozeOwner, name, readOnly, now);
      const decision = evaluatePolicy({
        upstreamDefault: current.defaultPolicy as Policy,
        tool: toolState,
        clientOverride: (tool?.clientPolicies[0]?.policy as Policy | undefined) ?? null,
        snoozedUntil: pauses.allowUntil,
        denyPausedUntil: pauses.denyUntil,
        now,
      });
      // ADR-0026 amendment: a Sperre with a purpose may let Clef relax its
      // refusal to ASK; for that, what the policy says WITHOUT the Sperre.
      const withoutSperre =
        decision.path === 'snooze-deny' && SperreGate.needsCheck(pauses.denies)
          ? evaluatePolicy({
              upstreamDefault: current.defaultPolicy as Policy,
              tool: toolState,
              clientOverride: (tool?.clientPolicies[0]?.policy as Policy | undefined) ?? null,
              snoozedUntil: pauses.allowUntil,
              denyPausedUntil: null,
              now,
            })
          : null;
      return { pauses, base: decision, withoutSperre };
    };
    const viaAllowPause = (d: { policy: Policy; path: string }) => d.policy === 'ALLOW' && d.path === 'snooze';

    /** Narrows the policy decision by the AI check result, then writes the
     * audit row: ADR-0008 audit first, if this write fails nothing is
     * forwarded. ASK: the id the user decides by is written with it, so a late
     * decision can be told apart (409) from a foreign/unknown id (404). */
    const decideAndAudit = async (
      ev: Awaited<ReturnType<typeof evaluate>>,
      check: GateResult | null,
      autoResult: AutoResult | null,
      sperreResult: SperreResult | null = null,
    ) => {
      // ADR-0029 narrows an ALLOW via pause; ADR-0030 resolves an AUTO into
      // ALLOW "auto" or ASK; a Sperre with a purpose may become ASK (never
      // ALLOW). None of them can produce ALLOW from anything else.
      const decision = relaxSperre(resolveAuto(narrow(ev.base, check), autoResult), ev.withoutSperre, sperreResult);
      const approvalId = decision.policy === 'ASK' ? ApprovalHub.newId() : null;
      // The allow pause this call goes through (ADR-0029 "calls since").
      const underPause = decision.policy === 'ALLOW' && (decision.path === 'snooze' || decision.path === 'snooze+ki') ? (ev.pauses.allow?.id ?? null) : null;
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
          intentStatus: intents.initialStatus,
          ...(check?.kind === 'match' || check?.kind === 'mismatch'
            ? { pauseCheckScore: check.score, pauseCheckChoice: check.choice, pausePurpose: ev.pauses.allow?.purpose ?? null, pausePurposeSource: ev.pauses.allow?.purpose ? (ev.pauses.allow.purposeSource ?? 'typed') : null }
            : {}),
          pauseSnoozeId: underPause,
          ...(autoResult?.kind === 'pass' || autoResult?.kind === 'below' ? { autoScore: autoResult.score } : {}),
          ...(sperreResult?.kind === 'inside' || sperreResult?.kind === 'outside' ? { sperreScore: sperreResult.score, pausePurpose: sperreResult.purpose, pausePurposeSource: 'typed' } : {}),
          ...auditDiagnostics(call.diagnostics),
        },
      });
      return { decision, approvalId, audit, pauses: ev.pauses, check, autoResult, sperreResult };
    };
    /** ADR-0026 amendment: Clef on a Sperre with a purpose (null otherwise). */
    const sperreCheck = async (ev: Awaited<ReturnType<typeof evaluate>>): Promise<SperreResult | null> =>
      // A rule DENY under the Sperre stays DENY whatever Clef says: no request.
      ev.withoutSperre && ev.withoutSperre.policy !== 'DENY' ? sperre.evaluate({ userId, denies: ev.pauses.denies, call: { upstream: upstream.name, tool: name, args } }) : null;
    /** ADR-0030: the Clef check of an AUTO decision (null for anything else).
     * The stored description/annotations of the tool, never the agent's. */
    const autoCheck = async (ev: Awaited<ReturnType<typeof evaluate>>): Promise<AutoResult | null> =>
      ev.base.policy === 'AUTO'
        ? auto.evaluate({
            userId,
            rule: current.autoRule,
            call: { upstream: upstream.name, tool: name, description: tool?.description ?? null, annotations: parseAnnotations(tool?.annotations ?? null), args },
          })
        : null;

    const first = await evaluate(receivedAt);
    // ADR-0029: an ALLOW that only an allow pause gave goes through the AI
    // check, under the access's serial lock, re-evaluated there (an earlier
    // check of this access may have ended the pause meanwhile). The check can
    // only keep the ALLOW or turn it into ASK (`narrow`).
    const decided =
      viaAllowPause(first.base) && gate.enabled
        ? await gate.serial(userId, mcpClientId, async () => {
            const ev = await evaluate(clock.now());
            let check: GateResult | null = null;
            if (viaAllowPause(ev.base)) {
              check = ev.pauses.allow
                ? await gate.evaluate({ userId, mcpClientId, upstreamId: upstream.id, pause: ev.pauses.allow, call: { upstream: upstream.name, tool: name, args } })
                : { kind: 'error' }; // no row to check against: hold (fail closed)
            }
            return decideAndAudit(ev, check, await autoCheck(ev), await sperreCheck(ev));
          })
        : await decideAndAudit(first, null, await autoCheck(first), await sperreCheck(first));
    const { decision, approvalId, audit, pauses } = decided;
    auditEvents.emit({ userId, auditId: audit.id });
    // ADR-0025: queue the advisory summary. Synchronous and never throws;
    // nothing below waits for it or reads it. ASK calls are queued right
    // after hold() so the summary can find them held.
    const queueIntent = (held: boolean) =>
      intents.enqueue({
        auditId: audit.id,
        userId,
        source: sourceKey({ sessionId: call.session?.id ?? null, mcpClientId }),
        receivedAt,
        approvalId,
        held,
      });
    if (decision.policy !== 'ASK') queueIntent(false);
    const shownName = name.slice(0, 100);
    const shownClient = call.clientName.slice(0, 100);
    const finish = async (data: {
      outcome: 'FORWARDED' | 'DENIED' | 'TIMED_OUT' | 'UPSTREAM_ERROR';
      decisionPath?: string;
      isError?: boolean;
      resultText?: string;
      decidedAt?: Date;
    }) => {
      await prisma.auditEntry.update({
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
      auditEvents.emit({ userId, auditId: audit.id });
    };

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
      const text =
        decision.path === 'unknown-tool'
          ? MSG.unknownTool(shownName)
          : decision.path === 'snooze-deny' && pauses.denyUntil
            ? MSG.blocked(shownName, pauses.denyScope === 'TOOL' ? null : upstream.name.slice(0, 100), pauses.denyUntil)
            : MSG.denied(shownName);
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
          readOnly,
          session: call.session,
          intent: NO_INTENT(intents.initialStatus),
          request: { endpoint, rpcId },
          // ADR-0029: why a paused call is asked after all (card, push).
          ...(checkView(decided.check) ? { pauseCheck: checkView(decided.check) } : {}),
          // ADR-0026 amendment: a Sperre's purpose check let this call be asked.
          ...(decided.sperreResult?.kind === 'outside' && decision.path === 'snooze-deny-ki-ask'
            ? { sperreCheck: { purpose: decided.sperreResult.purpose, score: decided.sperreResult.score } }
            : {}),
          // ADR-0030: why an AUTO call is asked (card, push).
          ...(autoView(decided.autoResult) ? { autoCheck: autoView(decided.autoResult) } : {}),
          // ADR-0031: the advisory review hint of a new/changed tool (display only).
          ...(tool && awaitingReview(toolState) ? { toolReview: reviewOf(tool) } : {}),
        },
        approvalId,
      );
      queueIntent(hub.get(userId, approvalId) !== null);
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
        // Revocation and pausing settle held calls (cancelWhere), but a call
        // that was between evaluation and hold() at that moment could still
        // be held afterwards. Re-check the client binding (gone: revoked) and
        // its pause (ADR-0024) before anything leaves.
        const stillBound = await prisma.mcpClient.findFirst({ where: { id: mcpClientId, userId }, select: { id: true, pausedAt: true } });
        if (!stillBound) {
          const text = MSG.revoked(shownName);
          await finish({ outcome: 'DENIED', decisionPath: `${rule}+revoked`, decidedAt: d.at, isError: true, resultText: text });
          return errorResult(text);
        }
        if (stillBound.pausedAt !== null) {
          const text = MSG.paused(shownName, shownClient);
          await finish({ outcome: 'DENIED', decisionPath: `${rule}+paused`, decidedAt: d.at, isError: true, resultText: text });
          return errorResult(text);
        }
        if (d.snoozeUntil && held.call.snoozable) {
          try {
            // READONLY only from a read-only tool; anything else narrows to TOOL.
            const scope = d.snoozeScope === 'UPSTREAM' || (d.snoozeScope === 'READONLY' && readOnly) ? d.snoozeScope : 'TOOL';
            // ADR-0029: this call is the pause's anchor for the AI check.
            // ADR-0029 amendment: with the human's "Wofür?", if given.
            const pause = await createSnooze(snoozeOwner, scope, name, d.snoozeUntil, d.at, 'ALLOW', audit.id, d.purpose ?? null, d.purposeSource ?? null);
            // Fire and forget: this call is forwarded meanwhile.
            if (gate.enabled) void settleCovered(held.call, scope, pause);
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
        let text = MSG.declined(shownName, displayName);
        if (d.pauseUntil) {
          // ADR-0026: "Ablehnen und nicht mehr fragen". Stored BEFORE the
          // agent gets its answer, so an immediate retry already hits it.
          // Not stored: this call is denied all the same (fail closed).
          const scope = d.pauseScope === 'UPSTREAM' ? 'UPSTREAM' : 'TOOL';
          try {
            // ADR-0026 amendment: anchored on this call, with the human's "Wofür?".
            await createSnooze(snoozeOwner, scope, name, d.pauseUntil, d.at, 'DENY', audit.id, d.purpose ?? null);
            text = MSG.blocked(shownName, scope === 'UPSTREAM' ? upstream.name.slice(0, 100) : null, d.pauseUntil);
          } catch (e) {
            console.warn(`proxy: deny pause not stored: ${errorTag(e)}`);
          }
        }
        await finish({ outcome: 'DENIED', decisionPath: `${rule}+denied:${d.via}`, decidedAt: d.at, isError: true, resultText: text });
        return errorResult(text);
      }
      if (d.kind === 'timeout') {
        const text = MSG.timedOut(shownName);
        await finish({ outcome: 'TIMED_OUT', decisionPath: `${rule}+timeout`, decidedAt: d.at, isError: true, resultText: text });
        return errorResult(text);
      }
      // aborted / shutdown / revoked / paused / flood: fail closed.
      const text =
        d.kind === 'flood'
          ? MSG.flood(shownName)
          : d.kind === 'revoked'
            ? MSG.revoked(shownName)
            : d.kind === 'paused'
              ? MSG.paused(shownName, shownClient)
              : MSG.approvalCancelled(shownName);
      await finish({ outcome: 'DENIED', decisionPath: `${rule}+${d.kind}`, decidedAt: d.at, isError: true, resultText: text });
      return errorResult(text);
    }

    if (decision.policy !== 'ALLOW') {
      // Unreachable (resolveAuto never returns AUTO; evaluatePolicy only
      // returns Policy values); fail closed rather than forward on anything
      // unexpected.
      const text = MSG.denied(shownName);
      await finish({ outcome: 'DENIED', isError: true, resultText: text });
      return errorResult(text);
    }

    // ALLOW (rule or snooze): forward.
    return forward(CALL_TIMEOUT_MS);
  }

  /** `/mcp/<slug>`: one upstream, names and instructions passed through. */
  async function buildSingle(call: McpCallContext, ref: UpstreamRef, displayName: string): Promise<Server> {
    const upstream = await prisma.upstream.findFirst({ where: { id: ref.id, userId: call.userId } });
    if (!upstream) throw new Error('upstream vanished mid-request');
    const endpoint = `/mcp/${upstream.slug}`;
    const upstreamInstructions = call.wantsInstructions ? (await liveInstructions(upstream)).instructions : upstream.instructions;

    const server = new Server(
      { name: `xitl/${upstream.slug}`, version: APP_VERSION },
      {
        capabilities: { tools: {} },
        instructions: instructionsFor(upstreamInstructions, upstream.description?.trim() || upstream.name),
      },
    );
    server.setRequestHandler('tools/list', async () => ({ tools: await listFor(upstream, call.mcpClientId, displayName) }));
    server.setRequestHandler('tools/call', async (request, reqCtx) =>
      callTool({
        call,
        displayName,
        upstream: { id: upstream.id, slug: upstream.slug, name: upstream.name, description: upstream.description },
        endpoint,
        name: request.params.name,
        args: request.params.arguments ?? {},
        signal: reqCtx.mcpReq.signal,
        rpcId: reqCtx.mcpReq.id,
      }),
    );
    return server;
  }

  /** `/mcp`: all of the user's upstreams, names prefixed `<slug>_` (ADR-0017). */
  async function buildUnified(call: McpCallContext, displayName: string): Promise<Server> {
    const { userId, mcpClientId } = call;
    const upstreams = await prisma.upstream.findMany({ where: { userId }, orderBy: { slug: 'asc' } });

    // Live only when the client asks for them (initialize): one connection per
    // usable upstream, in parallel; the stored ones otherwise.
    const live = call.wantsInstructions
      ? await Promise.all(upstreams.map((u) => liveInstructions(u)))
      : upstreams.map((u) => ({ instructions: u.instructions, state: storedState(u) }));
    const instructions = unifiedInstructions(
      upstreams.map((u, i) => ({
        slug: u.slug,
        name: u.name,
        description: u.description,
        instructions: live[i]?.instructions ?? null,
        state: live[i]?.state ?? storedState(u),
      })),
    );

    const server = new Server({ name: 'xitl', version: APP_VERSION }, { capabilities: { tools: {} }, instructions });

    server.setRequestHandler('tools/list', async () => {
      // Fresh rows (status/tokens may have changed since the factory ran).
      const rows = await prisma.upstream.findMany({ where: { userId }, orderBy: { slug: 'asc' } });
      // Degrade per upstream: one that fails is left out, the rest is listed.
      const results = await Promise.allSettled(rows.map((u) => listFor(u, mcpClientId, displayName)));
      const tools: Tool[] = [];
      results.forEach((r, i) => {
        const u = rows[i]!;
        if (r.status === 'rejected') return; // logged in listFor; state in lastFailureAt/status
        for (const t of r.value) {
          const name = unifiedName(u.slug, t.name);
          if (name) tools.push({ ...t, name });
          else console.warn(`proxy: upstream ${u.id}: tool name not listable on /mcp (MCP name rules)`);
        }
      });
      return { tools };
    });

    server.setRequestHandler('tools/call', async (request, reqCtx) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const split = splitUnifiedName(name);
      // Resolved ONLY among this user's upstreams; another user's slug is unknown.
      const upstream = split
        ? await prisma.upstream.findUnique({
            where: { userId_slug: { userId, slug: split.slug } },
            select: { id: true, slug: true, name: true, description: true },
          })
        : null;
      if (!split || !upstream) return denyUnresolved(call, name, args);
      return callTool({
        call,
        displayName,
        upstream,
        endpoint: UNIFIED_ENDPOINT,
        name: split.tool,
        args,
        signal: reqCtx.mcpReq.signal,
        rpcId: reqCtx.mcpReq.id,
      });
    });
    return server;
  }

  return async function buildMcpServer(ctx: McpRequestContext): Promise<Server> {
    const call = callContextFrom(ctx);
    const user = await prisma.user.findUnique({ where: { id: call.userId }, select: { displayName: true } });
    if (!user) throw new Error('user vanished mid-request');
    return call.upstream ? buildSingle(call, call.upstream, user.displayName) : buildUnified(call, user.displayName);
  };
}

export const buildMcpServer = makeBuildMcpServer();
