// Pending approvals (ADR-0004, ADR-0009): calls held for a human decision live
// here, in memory, keyed by an unguessable id. Channels (the approval page's
// SSE stream, Web Push) are decoupled through events; the proxy (mcp/server.ts)
// only awaits `decision`.
//
// Invariants (security-relevant, unit tested in pending.test.ts):
// - Exactly ONE outcome per call: the first of decide / timeout / abort /
//   shutdown wins; the entry leaves the map synchronously in that same tick,
//   so a second decision finds nothing (the API answers 409 via the audit row).
// - A decision is accepted only from the call's own user. Another user's id is
//   indistinguishable from an unknown one ("not-found").
// - Only "approve" ever leads to forwarding. Timeout, abort and shutdown are
//   denials (fail closed). A restart drops the map: nothing can be approved
//   after it.
// - At most `maxHeldPerUser` calls per user are held at a time (TC-45): the
//   next one settles at once as "flood" and is never announced (no SSE event,
//   no push).
// - Revoking a client or deleting an upstream settles its held calls as
//   "revoked" (`cancelWhere`), so nothing can approve them afterwards (TC-41).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { systemClock, type Clock } from '../lib/clock.js';
import { MAX_HELD_CALLS_PER_USER } from '../lib/limits.js';

export type Via = 'page' | 'push';

export type Decision =
  | { kind: 'approve'; via: Via; at: Date; snoozeUntil: Date | null }
  | { kind: 'deny'; via: Via; at: Date }
  | { kind: 'timeout'; at: Date }
  | { kind: 'aborted'; at: Date }
  | { kind: 'shutdown'; at: Date }
  /** The call's MCP client was revoked or its upstream deleted meanwhile. */
  | { kind: 'revoked'; at: Date }
  /** Refused at once: the user already has the maximum of held calls. */
  | { kind: 'flood'; at: Date };

/** What a channel may show about a held call. Never upstream credentials. */
export interface PendingCall {
  id: string;
  userId: number;
  mcpClientId: number;
  clientName: string;
  upstreamId: number;
  upstreamSlug: string;
  upstreamName: string;
  toolName: string;
  /** The call's arguments as the agent sent them (already JSON-safe). */
  args: unknown;
  auditId: number;
  /** The policy rule that said ASK ("policy:upstream-default", "new-tool", …). */
  rulePath: string;
  receivedAt: Date;
  deadline: Date;
  /** false for new/changed tools: those are looked at in the rules, not snoozed. */
  snoozable: boolean;
  /** The MCP session the call came in on (ADR-0016), null when sessionless. */
  session: { id: string; createdAt: Date } | null;
}

export interface ResolvedEvent {
  id: string;
  userId: number;
  decision: Decision;
}

export type DecideResult = 'ok' | 'not-found';

export type NewPending = Omit<PendingCall, 'id'>;

interface Entry {
  call: PendingCall;
  resolve: (d: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Event names: 'pending' (PendingCall), 'resolved' (ResolvedEvent), 'shutdown'. */
export class ApprovalHub extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  private readonly maxHeldPerUser: number;

  constructor(
    private readonly clock: Clock = systemClock,
    opts: { maxHeldPerUser?: number } = {},
  ) {
    super();
    this.maxHeldPerUser = opts.maxHeldPerUser ?? MAX_HELD_CALLS_PER_USER;
    // One listener per open SSE stream; more than 10 is normal, not a leak.
    this.setMaxListeners(0);
  }

  /** 128 random bits, URL-safe (22 chars). */
  static newId(): string {
    return crypto.randomBytes(16).toString('base64url');
  }

  static isId(raw: string | undefined): raw is string {
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{22}$/.test(raw);
  }

  /** Holds a call. The returned promise settles exactly once, never rejects.
   * The id can be fixed by the caller (the audit row is written with it first). */
  hold(input: NewPending, id: string = ApprovalHub.newId()): { call: PendingCall; decision: Promise<Decision> } {
    const call: PendingCall = { ...input, id };
    let resolve!: (d: Decision) => void;
    const decision = new Promise<Decision>((r) => (resolve = r));
    if (this.closed || this.entries.has(id)) {
      resolve({ kind: 'shutdown', at: this.clock.now() });
      return { call, decision };
    }
    // Synchronous count + insert: concurrent calls can't all slip under the cap.
    if (this.list(call.userId).length >= this.maxHeldPerUser) {
      resolve({ kind: 'flood', at: this.clock.now() });
      return { call, decision };
    }
    const delay = Math.max(0, call.deadline.getTime() - this.clock.now().getTime());
    const timer = setTimeout(() => this.settle(id, { kind: 'timeout', at: this.clock.now() }), delay);
    timer.unref?.();
    this.entries.set(id, { call, resolve, timer });
    this.safeEmit('pending', call);
    return { call, decision };
  }

  /** The user's decision. Only the call's own user can decide it. */
  decide(userId: number, id: string, d: { kind: 'approve'; via: Via; snoozeUntil: Date | null } | { kind: 'deny'; via: Via }): DecideResult {
    const entry = this.entries.get(id);
    if (!entry || entry.call.userId !== userId) return 'not-found';
    const at = this.clock.now();
    this.settle(id, d.kind === 'approve' ? { kind: 'approve', via: d.via, snoozeUntil: d.snoozeUntil, at } : { kind: 'deny', via: d.via, at });
    return 'ok';
  }

  /** The client went away (request aborted): deny. */
  abort(id: string): void {
    this.settle(id, { kind: 'aborted', at: this.clock.now() });
  }

  /** Settles every held call matching `pred` as "revoked" (denied). Used when
   * a client is revoked or an upstream deleted. Returns how many. */
  cancelWhere(pred: (call: PendingCall) => boolean): number {
    let n = 0;
    for (const [id, entry] of [...this.entries]) {
      if (!pred(entry.call)) continue;
      this.settle(id, { kind: 'revoked', at: this.clock.now() });
      n++;
    }
    return n;
  }

  /** One of the user's pending calls, or null (also for another user's id). */
  get(userId: number, id: string): PendingCall | null {
    const entry = this.entries.get(id);
    return entry && entry.call.userId === userId ? entry.call : null;
  }

  /** The user's pending calls, oldest first. */
  list(userId: number): PendingCall[] {
    return [...this.entries.values()].map((e) => e.call).filter((c) => c.userId === userId);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Server shutdown: every held call is denied; nothing new is held. */
  shutdown(): void {
    this.closed = true;
    for (const id of [...this.entries.keys()]) this.settle(id, { kind: 'shutdown', at: this.clock.now() });
    this.safeEmit('shutdown');
  }

  private settle(id: string, decision: Decision): void {
    const entry = this.entries.get(id);
    if (!entry) return; // already settled: first one wins
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    this.safeEmit('resolved', { id, userId: entry.call.userId, decision } satisfies ResolvedEvent);
  }

  /** A failing channel (SSE write, push) must never break the decision path. */
  private safeEmit(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (e) {
      console.error(`approvals: '${event}' listener failed`, e instanceof Error ? e.name : '');
    }
  }
}

/** The process-wide hub (single replica). */
export const approvals = new ApprovalHub();
