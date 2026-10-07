// The AUTO check on the decision path (ADR-0030 §3). The proxy
// (mcp/server.ts) asks this gate ONLY when `evaluatePolicy` said AUTO (an
// acknowledged, unchanged tool whose rule is AUTO, no live pause covering
// it). The result can only turn that AUTO into ALLOW "auto" (Clef clearly
// says the user's rule covers exactly this call: p(erlaubt) ≥ threshold) or
// into ASK; `resolveAuto` (pure) is the only place that maps it, and
// anything unexpected is ASK.
//
// `evaluate` (IO):
//   Clef not configured or the user's switch off     -> off     (no request)
//   no rule text on the upstream                     -> norule  (no request)
//   p ≥ threshold                                    -> pass
//   p < threshold                                    -> below
//   HTTP error, timeout, garbage                     -> error (raises the
//     shared outage notice; a successful check clears it)
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { AUTO_THRESHOLD_DEFAULT } from '../lib/limits.js';
import type { DecisionPath, Policy, PolicyDecision } from '../lib/policy.js';
import { parseNoul, withTimeout, type ClefConfig } from '../clef/client.js';
import type { PauseCheckOutage } from '../pausecheck/outage.js';
import { buildState, questions, QUESTION, type AutoCall } from './prompt.js';

export type AutoResult =
  | { kind: 'pass'; score: number }
  | { kind: 'below'; score: number }
  | { kind: 'error' }
  | { kind: 'off' }
  | { kind: 'norule' };

export type AutoPath = 'auto' | 'auto-ask' | 'auto-error' | 'auto-off' | 'auto-norule';

/** The decision after the AUTO check. Pure. Anything but an AUTO decision
 * passes through unchanged; an AUTO decision becomes ALLOW only on `pass`,
 * ASK on everything else, including a missing or unknown result. Never
 * returns AUTO. */
export function resolveAuto<P extends string>(
  decision: { policy: Policy; path: P },
  result: AutoResult | null,
): { policy: Policy; path: P | AutoPath } {
  if (decision.policy !== 'AUTO') return decision;
  switch (result?.kind) {
    case 'pass':
      return Number.isFinite(result.score) ? { policy: 'ALLOW', path: 'auto' } : { policy: 'ASK', path: 'auto-error' };
    case 'below':
      return { policy: 'ASK', path: 'auto-ask' };
    case 'off':
      return { policy: 'ASK', path: 'auto-off' };
    case 'norule':
      return { policy: 'ASK', path: 'auto-norule' };
    default:
      return { policy: 'ASK', path: 'auto-error' };
  }
}

/** p ≥ threshold passes. A threshold that is not a number in (0, 1] is the
 * default (never "everything passes"). Pure. */
export function autoVerdict(p: number, threshold: number): AutoResult {
  const t = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : AUTO_THRESHOLD_DEFAULT;
  if (!Number.isFinite(p) || p < 0 || p > 1) return { kind: 'error' };
  return p >= t ? { kind: 'pass', score: p } : { kind: 'below', score: p };
}

/** AUTO_THRESHOLD: a number in (0, 1]; anything else the default (logged). */
export function autoThresholdFromEnv(raw: string | undefined, warn: (l: string) => void = (l) => console.warn(l)): number {
  if (raw === undefined || raw.trim() === '') return AUTO_THRESHOLD_DEFAULT;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    warn(`auto: AUTO_THRESHOLD unusable, using ${AUTO_THRESHOLD_DEFAULT}`);
    return AUTO_THRESHOLD_DEFAULT;
  }
  return n;
}

export interface AutoInput {
  userId: number;
  /** The rule text of the upstream (Upstream.autoRule). */
  rule: string | null;
  call: AutoCall;
}

export class AutoGate {
  private readonly clock: Clock;
  private readonly log: (l: string) => void;

  constructor(
    private readonly config: ClefConfig | null,
    readonly threshold: number,
    readonly outage: PauseCheckOutage | null,
    opts: { clock?: Clock; log?: (l: string) => void } = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /** Configured AND the user's switch ("KI-Prüfung (Clef)") on. */
  async active(userId: number): Promise<boolean> {
    if (!this.config) return false;
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { pauseCheck: true } });
    return u?.pauseCheck === true;
  }

  /** One Clef request, no side effects (used by "Mit Verlauf testen" too). */
  async ask(rule: string, call: AutoCall): Promise<AutoResult> {
    const config = this.config;
    if (!config) return { kind: 'off' };
    if (!rule.trim()) return { kind: 'norule' };
    const r = await withTimeout(config.timeoutMs, async (signal) => parseNoul(await config.client.ask(buildState(rule, call), questions(), signal), QUESTION));
    if ('error' in r) {
      // Class only: never the URL path, the state or the answer.
      console.warn(`auto: check failed (${r.timedOut ? 'timeout' : r.error instanceof Error ? r.error.name : 'unknown'})`);
      return { kind: 'error' };
    }
    return autoVerdict(r.value, this.threshold);
  }

  async evaluate(input: AutoInput): Promise<AutoResult> {
    if (!(await this.active(input.userId))) return { kind: 'off' };
    if (!input.rule || !input.rule.trim()) return { kind: 'norule' };
    const started = this.clock.now().getTime();
    const result = await this.ask(input.rule, input.call);
    if (result.kind === 'error') this.outage?.failed(input.userId);
    else if (result.kind === 'pass' || result.kind === 'below') {
      this.outage?.cleared(input.userId);
      this.log(`auto: ${result.kind} p(erlaubt)=${result.score.toFixed(3)} in ${this.clock.now().getTime() - started} ms`);
    }
    return result;
  }
}

/** For DecisionPath typing at the call site. */
export type ResolvedPath = DecisionPath | AutoPath;
export type { PolicyDecision };
