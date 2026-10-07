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
//   "revoked" (`cancelWhere`), so nothing can approve them afterwards (TC-41);
//   pausing a client (ADR-0024) settles them the same way as "paused" (TC-104).
// - The intent summary (ADR-0025) is display data only: `setIntent` stores it
//   on a still-held call and announces it ('intent'); it never settles,
//   extends or otherwise touches a decision, and a settled call ignores it.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { systemClock, type Clock } from '../lib/clock.js';
import { MAX_HELD_CALLS_PER_USER } from '../lib/limits.js';
import type { SnoozeScope } from './snooze.js';
import type { IntentView } from '../intent/queue.js';
import type { AutoCheckView } from '../auto/text.js';
import type { PauseCheckView } from '../pausecheck/text.js';

/** How a decision was made: in the app, from the notification, by a pause
 * set on another held call (it also settles the held calls it covers,
 * routes/approvals.ts `heldCoveredBy`), by hiding the upstream from the
 * call's client (ADR-0032 §4, routes/upstreamTools.ts) or by pausing the
 * upstream (ADR-0033 §4, routes/upstreams.ts); the last two deny only, the
 * agent gets the unknown-tool text. 'pause', 'client-hidden' and
 * 'upstream-paused' never come from a request body. */
export type Via = 'page' | 'push' | 'pause' | 'client-hidden' | 'upstream-paused';
/** Vias that only ever deny (settled by a setting, not decided). */
type DenyOnlyVia = 'client-hidden' | 'upstream-paused';

/** TC-173: a Zeitfreigabe purpose the human typed, or an AI suggestion the
 * human tapped. A Sperre's purpose has no source field: always typed. */
export type PurposeSource = 'typed' | 'suggested';

export type Decision =
  | { kind: 'approve'; via: Exclude<Via, DenyOnlyVia>; at: Date; snoozeUntil: Date | null; snoozeScope?: SnoozeScope; purpose?: string | null; purposeSource?: PurposeSource | null }
  /** `pauseUntil`/`pauseScope`: also refuse this tool/upstream for this
   * client until then (deny pause, ADR-0026). */
  | { kind: 'deny'; via: Via; at: Date; pauseUntil?: Date | null; pauseScope?: Exclude<SnoozeScope, 'READONLY'>; purpose?: string | null }
  | { kind: 'timeout'; at: Date }
  | { kind: 'aborted'; at: Date }
  | { kind: 'shutdown'; at: Date }
  /** The call's MCP client was revoked or its upstream deleted meanwhile. */
  | { kind: 'revoked'; at: Date }
  /** The call's MCP client was paused meanwhile (ADR-0024). */
  | { kind: 'paused'; at: Date }
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
  /** Read-only by the tool's stored annotations: offers the READONLY snooze. */
  readOnly: boolean;
  /** The MCP session the call came in on (ADR-0016), null when sessionless. */
  session: { id: string; createdAt: Date } | null;
  /** The advisory intent summary (ADR-0025); absent = feature off. */
  intent?: IntentView;
  /** ADR-0029: the AI check sent this call back (mismatch: the pause ended;
   * error: Clef unreachable). Display only; absent = not checked. */
  pauseCheck?: PauseCheckView;
  /** ADR-0030: why an AUTO call was asked (below the threshold, Clef error,
   * Clef off, no rule). Display only; absent = not an AUTO call. */
  autoCheck?: AutoCheckView;
  /** ADR-0026 amendment: Clef judged the call outside the Sperre's purpose,
   * so it is asked instead of refused. Display only. */
  sperreCheck?: { purpose: string; score: number };
  /** ADR-0031: the advisory review hint of a new/changed tool, as it was when
   * the call was held. Display only; never read by a decision. */
  toolReview?: { attention: boolean; reasons: string[]; label: string | null };
  /** The JSON-RPC request this call came in as, for the client's
   * `notifications/cancelled` (`cancelByRequest`). Never shown to a channel. */
  request?: { endpoint: string; rpcId: string | number };
}

/** Who sent a `notifications/cancelled`, as the gate verified it. */
export interface CancelOwner {
  userId: number;
  mcpClientId: number;
  /** The MCP session of the cancel request; null when sessionless. */
  sessionId: string | null;
  /** `/mcp` or `/mcp/<slug>`. */
  endpoint: string;
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

/** Event names: 'pending' (PendingCall), 'resolved' (ResolvedEvent),
 * 'intent' (PendingCall, its summary changed), 'checked' (PendingCall, the
 * AI check sent it back, ADR-0029), 'shutdown'. */
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
  decide(
    userId: number,
    id: string,
    d:
      | { kind: 'approve'; via: Exclude<Via, DenyOnlyVia>; snoozeUntil: Date | null; snoozeScope?: SnoozeScope; purpose?: string | null; purposeSource?: PurposeSource | null }
      | { kind: 'deny'; via: Via; pauseUntil?: Date | null; pauseScope?: Exclude<SnoozeScope, 'READONLY'>; purpose?: string | null },
  ): DecideResult {
    const entry = this.entries.get(id);
    if (!entry || entry.call.userId !== userId) return 'not-found';
    const at = this.clock.now();
    this.settle(
      id,
      d.kind === 'approve'
        ? {
            kind: 'approve',
            via: d.via,
            snoozeUntil: d.snoozeUntil,
            snoozeScope: d.snoozeScope,
            purpose: d.purpose ?? null,
            // No purpose, no source.
            purposeSource: d.purpose ? (d.purposeSource === 'suggested' ? 'suggested' : 'typed') : null,
            at,
          }
        : d.pauseUntil
          ? { kind: 'deny', via: d.via, at, pauseUntil: d.pauseUntil, pauseScope: d.pauseScope === 'UPSTREAM' ? 'UPSTREAM' : 'TOOL', purpose: d.purpose ?? null }
          : { kind: 'deny', via: d.via, at },
    );
    return 'ok';
  }

  /** Attaches the intent summary to a still-held call of `userId` and emits
   * 'intent'. false when the call is no longer held (or not the user's).
   * Display data only: nothing here can decide the call. */
  setIntent(userId: number, id: string, intent: IntentView): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.call.userId !== userId) return false;
    entry.call.intent = { ...intent };
    this.safeEmit('intent', entry.call);
    return true;
  }

  /** ADR-0029: a held call the AI check sent back on the settle path (a new
   * pause did not take it). Display only, like setIntent: emits 'checked'. */
  setPauseCheck(userId: number, id: string, view: PauseCheckView): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.call.userId !== userId) return false;
    entry.call.pauseCheck = { ...view };
    this.safeEmit('checked', entry.call);
    return true;
  }

  /** The client went away (request aborted): deny. */
  abort(id: string): void {
    this.settle(id, { kind: 'aborted', at: this.clock.now() });
  }

  /** The client cancelled its request (`notifications/cancelled`, MCP): the
   * held call with the same user, client, session (or none on both sides),
   * endpoint and JSON-RPC id is settled as "aborted" (deny). Only when exactly
   * ONE call matches: sessionless clients (Claude.ai) can reuse ids across
   * parallel chats, and an ambiguous cancel must not deny the other chat's
   * call; it then simply waits for its timeout as before. Returns how many
   * were settled (0 or 1). */
  cancelByRequest(owner: CancelOwner, rpcId: string | number): number {
    const matches = [...this.entries].filter(
      ([, e]) =>
        e.call.userId === owner.userId &&
        e.call.mcpClientId === owner.mcpClientId &&
        (e.call.session?.id ?? null) === owner.sessionId &&
        e.call.request !== undefined &&
        e.call.request.endpoint === owner.endpoint &&
        e.call.request.rpcId === rpcId,
    );
    if (matches.length !== 1) return 0;
    this.settle(matches[0][0], { kind: 'aborted', at: this.clock.now() });
    return 1;
  }

  /** Settles every held call matching `pred` as denied: "revoked" when a
   * client is revoked or an upstream deleted, "paused" when a client is
   * paused (ADR-0024). Returns how many. */
  cancelWhere(pred: (call: PendingCall) => boolean, reason: 'revoked' | 'paused' = 'revoked'): number {
    let n = 0;
    for (const [id, entry] of [...this.entries]) {
      if (!pred(entry.call)) continue;
      this.settle(id, { kind: reason, at: this.clock.now() });
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
