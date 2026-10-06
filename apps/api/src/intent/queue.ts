// The intent worker (ADR-0025 §2, §6): one in-memory queue, concurrency 1.
//
// ADVISORY ONLY. Nothing on the decision path reads or waits for this: the
// proxy (mcp/server.ts) enqueues after the audit row is written and never
// awaits; `enqueue` is synchronous and cannot throw into the caller; any model
// or DB failure ends as FAILED (or nothing) for that one call. The summary
// never reaches the agent.
//
// Order: calls of one source (session, else client; group.ts) strictly by
// `receivedAt`, because each call's request is the previous call's stored
// prefix + one turn. Among sources, one with a held (ASK) call goes first, so
// a held call waits only behind its own group's earlier calls. Over
// MAX_INTENT_QUEUE, the oldest entries that are not held are SKIPPED.
//
// Per call: find its predecessor in the source; if that continues the group
// (group.ts) and has a context, continue it (unless over the caps, prompt.ts),
// else start fresh. Ask the model (timeout), parse, floor the risk, store the
// exact turn + raw answer, emit 'intent'.
import { EventEmitter } from 'node:events';
import { systemClock, type Clock } from '../lib/clock.js';
import { INTENT_REQUEST_TIMEOUT_MS, MAX_INTENT_ANSWER_CHARS, MAX_INTENT_QUEUE } from '../lib/limits.js';
import { continuesGroup } from './group.js';
import type { IntentModel } from './model.js';
import { parseAnswer, summaryText } from './parse.js';
import { buildRequest, outcomeWord, type ContextTurn } from './prompt.js';
import { floorRisk, hintOfStored, type Risk } from './risk.js';

export type IntentStatus = 'OFF' | 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** What the UI may see of a call's summary (never prompt/answer text). */
export interface IntentView {
  status: IntentStatus;
  summary: string | null;
  risk: Risk | null;
  lowered: boolean | null;
}

export const NO_INTENT = (status: IntentStatus): IntentView => ({ status, summary: null, risk: null, lowered: null });

export interface IntentJob {
  auditId: number;
  userId: number;
  /** group.ts sourceKey */
  source: string;
  receivedAt: Date;
  /** The pending approval's id (ASK), else null. */
  approvalId: string | null;
  /** Still held for a decision: served first. */
  held: boolean;
}

/** The call to summarize, with its tool's stored facts. */
export interface IntentCallRow {
  id: number;
  userId: number;
  mcpClientId: number | null;
  sessionId: string | null;
  receivedAt: Date;
  upstreamId: number | null;
  upstreamName: string | null;
  toolName: string;
  /** The audit row's JSON text. */
  arguments: string;
  /** KnownTool's stored description / annotations (JSON text). */
  description: string | null;
  annotations: string | null;
}

export interface IntentPrevRow {
  id: number;
  mcpClientId: number | null;
  sessionId: string | null;
  receivedAt: Date;
  intentContextId: number | null;
}

/** An answered call of a context (DONE: prompt and answer stored). */
export interface IntentTurnRow {
  id: number;
  upstreamId: number | null;
  toolName: string;
  intentPrompt: string;
  intentAnswer: string;
  outcome: string;
  policy: string;
  decisionPath: string;
  isError: boolean | null;
}

export type IntentResult =
  | {
      status: 'DONE';
      summary: string;
      risk: Risk;
      modelRisk: Risk;
      lowered: boolean;
      model: string;
      at: Date;
      prompt: string;
      answer: string;
      contextId: number;
    }
  | { status: 'FAILED'; model: string; at: Date; prompt: string | null; contextId: number | null };

/** The DB side, injected (store.ts; an in-memory fake in tests). */
export interface IntentStore {
  loadCall(auditId: number, userId: number): Promise<IntentCallRow | null>;
  /** The latest earlier call of the same source (same session; or same client, sessionless). */
  predecessor(call: IntentCallRow): Promise<IntentPrevRow | null>;
  /** The answered calls of a context, oldest first. */
  contextTurns(userId: number, contextId: number): Promise<IntentTurnRow[]>;
  save(auditId: number, result: IntentResult): Promise<void>;
  skip(auditIds: number[]): Promise<void>;
}

/** Emitted for every call that leaves the queue (DONE / FAILED / SKIPPED). */
export interface IntentEvent {
  auditId: number;
  userId: number;
  approvalId: string | null;
  view: IntentView;
}

const toolKey = (upstreamId: number | null, tool: string) => `${upstreamId ?? '-'}:${tool}`;

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const errName = (e: unknown) => (e instanceof Error ? e.name : 'unknown');

export interface IntentQueueOptions {
  /** null = feature off: enqueue does nothing. */
  model: IntentModel | null;
  store: IntentStore;
  clock?: Clock;
  timeoutMs?: number;
  maxQueue?: number;
  limits?: { maxCalls?: number; maxChars?: number };
}

/** Event names: 'intent' (IntentEvent). */
export class IntentQueue extends EventEmitter {
  private readonly jobs: IntentJob[] = [];
  private running = false;
  private idleWaiters: (() => void)[] = [];
  private readonly model: IntentModel | null;
  private readonly store: IntentStore;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxQueue: number;
  private readonly limits: IntentQueueOptions['limits'];

  constructor(opts: IntentQueueOptions) {
    super();
    this.model = opts.model;
    this.store = opts.store;
    this.clock = opts.clock ?? systemClock;
    this.timeoutMs = opts.timeoutMs ?? INTENT_REQUEST_TIMEOUT_MS;
    this.maxQueue = opts.maxQueue ?? MAX_INTENT_QUEUE;
    this.limits = opts.limits;
    this.setMaxListeners(0);
  }

  get enabled(): boolean {
    return this.model !== null;
  }

  /** The status a new audit row gets. */
  get initialStatus(): IntentStatus {
    return this.enabled ? 'PENDING' : 'OFF';
  }

  get size(): number {
    return this.jobs.length;
  }

  /** Queues a call. Synchronous, never throws, never awaited by the caller. */
  enqueue(job: IntentJob): void {
    if (!this.model) return;
    try {
      this.jobs.push({ ...job });
      if (this.jobs.length > this.maxQueue) this.overflow();
      this.kick();
    } catch (e) {
      console.error(`intent: enqueue failed: ${errName(e)}`);
    }
  }

  /** The held call was decided (or ended): no longer served first. */
  release(approvalId: string): void {
    for (const j of this.jobs) if (j.approvalId === approvalId) j.held = false;
  }

  /** Resolves once nothing is queued or running (tests). */
  idle(): Promise<void> {
    if (!this.running && this.jobs.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** The job to run next (see the header). Exposed for TC-109. */
  peek(): IntentJob | null {
    if (this.jobs.length === 0) return null;
    const before = (a: IntentJob, b: IntentJob) =>
      a.receivedAt.getTime() - b.receivedAt.getTime() || a.auditId - b.auditId;
    // The head (oldest) of each source: only heads may run.
    const heads = new Map<string, IntentJob>();
    for (const j of this.jobs) {
      const h = heads.get(j.source);
      if (!h || before(j, h) < 0) heads.set(j.source, j);
    }
    const heldSources = new Set(this.jobs.filter((j) => j.held).map((j) => j.source));
    const pool = [...heads.values()].filter((h) => heldSources.size === 0 || heldSources.has(h.source));
    return pool.sort(before)[0] ?? null;
  }

  private overflow(): void {
    const dropped: IntentJob[] = [];
    while (this.jobs.length > this.maxQueue) {
      const victims = this.jobs.filter((j) => !j.held);
      // All held (can't happen with the per-user hold cap): drop the newest.
      const victim = victims.length > 0 ? victims.reduce((a, b) => (b.receivedAt < a.receivedAt ? b : a)) : this.jobs[this.jobs.length - 1]!;
      this.jobs.splice(this.jobs.indexOf(victim), 1);
      dropped.push(victim);
    }
    console.warn(`intent: queue full, ${dropped.length} call(s) skipped`);
    void this.store.skip(dropped.map((j) => j.auditId)).catch((e) => console.error(`intent: skip failed: ${errName(e)}`));
    for (const j of dropped) this.emitIntent(j, NO_INTENT('SKIPPED'));
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    try {
      for (;;) {
        const job = this.peek();
        if (!job) break;
        this.jobs.splice(this.jobs.indexOf(job), 1);
        try {
          await this.process(job);
        } catch (e) {
          console.error(`intent: call ${job.auditId} failed: ${errName(e)}`);
        }
      }
    } finally {
      this.running = false;
      if (this.jobs.length > 0) this.kick();
      else for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private emitIntent(job: IntentJob, view: IntentView): void {
    try {
      this.emit('intent', { auditId: job.auditId, userId: job.userId, approvalId: job.approvalId, view } satisfies IntentEvent);
    } catch (e) {
      console.error(`intent: listener failed: ${errName(e)}`);
    }
  }

  private async process(job: IntentJob): Promise<void> {
    const model = this.model!;
    let prompt: string | null = null;
    let contextId: number | null = null;
    let result: IntentResult;
    try {
      const call = await this.store.loadCall(job.auditId, job.userId);
      if (!call) return; // row gone (user deleted): nothing to do
      const prev = await this.store.predecessor(call);
      let turns: IntentTurnRow[] = [];
      if (prev && prev.intentContextId !== null && continuesGroup(prev, call)) {
        turns = await this.store.contextTurns(call.userId, prev.intentContextId);
        contextId = prev.intentContextId;
      }
      const context: ContextTurn[] = turns.map((t) => ({
        prompt: t.intentPrompt,
        answer: t.intentAnswer,
        toolKey: toolKey(t.upstreamId, t.toolName),
        outcome: outcomeWord(t),
      }));
      let annotations: unknown = null;
      try {
        annotations = call.annotations ? JSON.parse(call.annotations) : null;
      } catch {
        annotations = null;
      }
      const req = buildRequest(
        {
          upstream: call.upstreamName ?? '?',
          tool: call.toolName,
          description: call.description,
          annotations,
          args: parseArgs(call.arguments),
          toolKey: toolKey(call.upstreamId, call.toolName),
        },
        context,
        this.limits,
      );
      // Over a cap: a new context. (A context whose calls all failed has no
      // turns to drop and simply goes on.)
      if ((req.fresh && turns.length > 0) || contextId === null) contextId = call.id;
      prompt = req.prompt;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let reply: Awaited<ReturnType<IntentModel['complete']>>;
      try {
        reply = await model.complete(req.messages, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      const answer = reply.text;
      // The model that actually answered (llama.cpp resolves the alias).
      const answeredBy = reply.model ?? model.name;
      const parsed = answer.length <= MAX_INTENT_ANSWER_CHARS ? parseAnswer(answer) : null;
      if (!parsed) {
        console.warn(`intent: call ${job.auditId}: unusable answer`);
        result = { status: 'FAILED', model: answeredBy, at: this.clock.now(), prompt, contextId };
      } else {
        const floored = floorRisk(hintOfStored(call.annotations), parsed.risk);
        result = {
          status: 'DONE',
          summary: summaryText(parsed),
          risk: floored.risk,
          modelRisk: parsed.risk,
          lowered: floored.lowered,
          model: answeredBy,
          at: this.clock.now(),
          prompt,
          answer,
          contextId,
        };
      }
    } catch (e) {
      console.warn(`intent: call ${job.auditId}: model request failed: ${errName(e)}`);
      result = { status: 'FAILED', model: model.name, at: this.clock.now(), prompt, contextId };
    }
    await this.store.save(job.auditId, result);
    this.emitIntent(
      job,
      result.status === 'DONE'
        ? { status: 'DONE', summary: result.summary, risk: result.risk, lowered: result.lowered }
        : NO_INTENT('FAILED'),
    );
  }
}
