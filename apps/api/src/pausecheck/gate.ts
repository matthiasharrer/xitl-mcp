// The AI check of an allow pause on the decision path (ADR-0029). The proxy
// (mcp/server.ts) asks this gate ONLY when `evaluatePolicy` said ALLOW via
// path `snooze`; the result can only keep that ALLOW or turn it into ASK
// (`narrow`, pure). Everything else (rule ALLOW, DENY, deny pauses, ASK) never
// reaches here.
//
// `evaluate` (IO):
//   - feature off (no PAUSE_CHECK_URL), pause without anchor (granted before
//     the check existed), or the user's switch off      -> blind (as before)
//   - otherwise: state = anchor (tool, arguments, its intent summary if DONE)
//     + the calls forwarded under THIS pause since (same snooze id, user,
//     client, upstream; newest N, oldest first) + the new call; one Clef
//     request with a timeout
//       p(gleich) ≥ threshold                          -> match
//       below                                          -> mismatch: every
//         allow pause of this access on this upstream is deleted here (same
//         effect as "Beenden" in the UI, which emits no event either)
//       HTTP error, timeout, garbage, anchor row gone  -> error (fail closed:
//         the caller holds the call; the pause stays); a model failure also
//         raises the outage notice (outage.ts), a success clears it.
// `serial` runs one access's checks strictly in order (ADR-0029 §8), so the
// "calls since" a check sees include every call checked before it.
import { prisma } from '../db.js';
import { pauseEvents } from '../lib/pauseEvents.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { PAUSE_CHECK_MAX_SINCE } from '../lib/limits.js';
import type { DecisionPath, PolicyDecision } from '../lib/policy.js';
import type { MatchedAllowPause } from '../approval/snooze.js';
import { verdict, type Deviation, type PauseCheckConfig } from './check.js';
import { buildState, purposeText, type CheckCall } from './prompt.js';
import { PauseCheckOutage } from './outage.js';

export type GateResult =
  | { kind: 'blind' }
  | { kind: 'match'; score: number; choice: 'gleich' }
  | { kind: 'mismatch'; score: number; choice: Deviation }
  | { kind: 'error' };

/** The decision after the check. Pure. Narrows only: anything but an ALLOW
 * via `snooze` passes through unchanged, and no result ever yields ALLOW
 * from anything that was not ALLOW. */
export function narrow(decision: PolicyDecision, result: GateResult | null): { policy: PolicyDecision['policy']; path: DecisionPath | 'snooze+ki' | 'snooze-ki-mismatch' | 'snooze-ki-error' } {
  if (decision.policy !== 'ALLOW' || decision.path !== 'snooze' || result === null) return decision;
  switch (result.kind) {
    case 'blind':
      return decision;
    case 'match':
      return { policy: 'ALLOW', path: 'snooze+ki' };
    case 'mismatch':
      return { policy: 'ASK', path: 'snooze-ki-mismatch' };
    default:
      // 'error' and anything unexpected: hold (fail closed).
      return { policy: 'ASK', path: 'snooze-ki-error' };
  }
}

/** Audit outcomes that count as "forwarded under the pause" (in flight too). */
const FORWARDED_OUTCOMES = ['FORWARDED', 'UPSTREAM_ERROR', 'PENDING'] as const;

export interface GateInput {
  userId: number;
  mcpClientId: number;
  upstreamId: number;
  pause: MatchedAllowPause;
  /** The call to check (upstream display name, tool, arguments). */
  call: CheckCall;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class PauseGate {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly clock: Clock;
  readonly outage: PauseCheckOutage;

  constructor(
    private readonly config: PauseCheckConfig | null,
    opts: { clock?: Clock; outage?: PauseCheckOutage; log?: (l: string) => void } = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.outage = opts.outage ?? new PauseCheckOutage(this.clock);
    this.log = opts.log ?? ((l) => console.log(l));
  }

  private readonly log: (l: string) => void;

  /** PAUSE_CHECK_URL is configured. */
  get enabled(): boolean {
    return this.config !== null;
  }

  /** Configured AND the user's switch is on (a missing user counts as off:
   * there is nothing to check for, and no pause of theirs can exist). */
  async active(userId: number): Promise<boolean> {
    if (!this.config) return false;
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { pauseCheck: true } });
    return u?.pauseCheck === true;
  }

  /** Runs `fn` after every earlier `serial` of the same access has settled. */
  serial<T>(userId: number, mcpClientId: number, fn: () => Promise<T>): Promise<T> {
    const key = `${userId}:${mcpClientId}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  async evaluate(input: GateInput): Promise<GateResult> {
    const config = this.config;
    if (!config || input.pause.anchorAuditId === null) return { kind: 'blind' };
    if (!(await this.active(input.userId))) return { kind: 'blind' };

    const anchor = await prisma.auditEntry.findFirst({
      where: { id: input.pause.anchorAuditId, userId: input.userId },
      select: { toolName: true, arguments: true, intentStatus: true, intentSummary: true, upstream: { select: { name: true } } },
    });
    if (!anchor) {
      // Nothing to compare with: hold (fail closed). Not a model outage.
      console.warn('pause check: anchor row missing, call held');
      return { kind: 'error' };
    }
    const sinceRows = await prisma.auditEntry.findMany({
      where: {
        userId: input.userId,
        mcpClientId: input.mcpClientId,
        upstreamId: input.upstreamId,
        pauseSnoozeId: input.pause.id,
        outcome: { in: [...FORWARDED_OUTCOMES] },
      },
      orderBy: { id: 'desc' },
      take: PAUSE_CHECK_MAX_SINCE,
      select: { toolName: true, arguments: true, upstream: { select: { name: true } } },
    });
    const purpose = input.pause.purpose ?? null;
    const state = buildState({
      purpose,
      anchor: { upstream: anchor.upstream?.name ?? input.call.upstream, tool: anchor.toolName, args: parseArgs(anchor.arguments) },
      anchorSummary: anchor.intentStatus === 'DONE' ? anchor.intentSummary : null,
      since: sinceRows.reverse().map((r) => ({ upstream: r.upstream?.name ?? input.call.upstream, tool: r.toolName, args: parseArgs(r.arguments) })),
      next: input.call,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
    timer.unref?.();
    const started = this.clock.now().getTime();
    let result: GateResult;
    try {
      const answer = await config.check.check(state, ctrl.signal, purposeText(purpose) !== null);
      const v = verdict(answer, config.threshold);
      result = v.kind === 'match' ? { kind: 'match', score: v.score, choice: 'gleich' } : { kind: 'mismatch', score: v.score, choice: v.deviation };
    } catch (e) {
      // Class only: never the URL path, the state or the answer.
      console.warn(`pause check failed (${ctrl.signal.aborted ? 'timeout' : e instanceof Error ? e.name : 'unknown'}), call held`);
      this.outage.failed(input.userId);
      return { kind: 'error' };
    } finally {
      clearTimeout(timer);
    }
    this.outage.cleared(input.userId);
    this.log(`pause check: ${result.kind} p(gleich)=${result.score.toFixed(3)} in ${this.clock.now().getTime() - started} ms`);
    if (result.kind === 'mismatch') {
      try {
        // ADR-0029 (Matthias: "stop the pause altogether"): once the agent has
        // swerved, every allow pause of THIS access on THIS upstream ends, not
        // only the matched row; another covering one would let the next call
        // through. Deny pauses (Sperren) and other accesses stay.
        await prisma.snooze.deleteMany({
          where: { userId: input.userId, mcpClientId: input.mcpClientId, upstreamId: input.upstreamId, effect: 'ALLOW' },
        });
        pauseEvents.emit({ userId: input.userId });
      } catch (e) {
        // The call is held all the same; the next call is checked again.
        console.warn(`pause check: pause not ended: ${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
    return result;
  }
}
