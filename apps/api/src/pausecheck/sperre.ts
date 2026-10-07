// Sperre with a purpose (ADR-0026 amendment, Matthias 2026-10-07). A deny
// pause ("Sperre") refuses every covered call (`snooze-deny`, policy.ts step
// 2). When the human typed a purpose ("Wofür?") on it, Clef may judge a
// covered call as clearly OUTSIDE what the human wanted to block; such a call
// is then NOT refused by the Sperre but falls back to ASK, never to ALLOW:
// the decision becomes the stricter of ASK and what the policy says without
// the Sperre (rule DENY stays DENY; ALLOW / AUTO / allow-Zeitfreigabe / ASK
// become ASK `snooze-deny-ki-ask`). Everything else keeps the refusal:
//   no purpose on any covering Sperre, a covering Sperre without purpose or
//   without anchor row, Clef off / switch off            -> `snooze-deny`
//   p(outside) < threshold                                 -> `snooze-deny` (score)
//   HTTP error, timeout, garbage                           -> `snooze-deny`
//     (and the shared outage notice)
// With several covering Sperren, ALL must have a purpose and Clef must say
// "outside" for EACH; the first that doesn't refuses. The Sperre stays in
// place either way.
//
// Request: state = the trusted purpose (one line, `<` escaped) + the blocked
// anchor call + the new call, each call as ONE JSON line in our own
// `<call>` / `</call>` lines (pausecheck/prompt.ts callBlock); question noul
// `ausserhalb` (English). The threshold is PAUSE_CHECK_THRESHOLD.
import { prisma } from '../db.js';
import type { Policy } from '../lib/policy.js';
import { PAUSE_CHECK_THRESHOLD_DEFAULT } from '../lib/limits.js';
import { parseNoul, withTimeout, type ClefConfig, type ClefQuestion } from '../clef/client.js';
import type { CoveringDeny } from '../approval/snooze.js';
import { callBlock, purposeText, type CheckCall } from './prompt.js';
import type { PauseCheckOutage } from './outage.js';

export const SPERRE_QUESTION = 'ausserhalb';
export const SPERRE_INSTRUCTIONS = 'Is the new call clearly outside what the human wanted to block? If in doubt: no.';
export const SPERRE_PURPOSE_LABEL = 'Purpose the human stated when blocking (trusted, written by the human):';
export const SPERRE_ANCHOR_LABEL = 'Call the human refused when blocking (untrusted agent data):';
export const SPERRE_NEXT_LABEL = 'New call (untrusted agent data):';

export function sperreState(purpose: string, anchor: CheckCall, next: CheckCall): string {
  return `${SPERRE_PURPOSE_LABEL}\n${purposeText(purpose) ?? ''}\n\n${SPERRE_ANCHOR_LABEL}\n${callBlock(anchor)}\n\n${SPERRE_NEXT_LABEL}\n${callBlock(next)}`;
}

export const sperreQuestions = (): Record<string, ClefQuestion> => ({ [SPERRE_QUESTION]: { type: 'noul', instructions: SPERRE_INSTRUCTIONS } });

export type SperreResult =
  | { kind: 'outside'; score: number; purpose: string }
  | { kind: 'inside'; score: number; purpose: string }
  | { kind: 'error' }
  | { kind: 'off' }
  | { kind: 'nopurpose' };

export type SperrePath = 'snooze-deny-ki-ask';

const STRICTNESS: Record<string, number> = { ALLOW: 0, AUTO: 1, ASK: 2, DENY: 3 };

/** The decision after a Sperre's purpose check. Pure. Acts only on a DENY
 * via `snooze-deny`; only `outside` relaxes it, and then to the stricter of
 * ASK and `withoutSperre` (the policy evaluated with the Sperre ignored):
 * never ALLOW, never AUTO. Anything else keeps the refusal. */
export function relaxSperre<P extends string>(
  decision: { policy: Policy; path: P },
  withoutSperre: { policy: Policy; path: string } | null,
  result: SperreResult | null,
): { policy: Policy; path: P | SperrePath | string } {
  if (decision.policy !== 'DENY' || decision.path !== 'snooze-deny') return decision;
  if (result?.kind !== 'outside' || !Number.isFinite(result.score) || !withoutSperre) return decision;
  const strict = STRICTNESS[withoutSperre.policy];
  // Unknown values count as DENY (fail closed): keep the refusal.
  if (strict === undefined || strict >= STRICTNESS.DENY!) return decision;
  return { policy: 'ASK', path: 'snooze-deny-ki-ask' };
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class SperreGate {
  constructor(
    private readonly config: ClefConfig | null,
    readonly threshold: number,
    readonly outage: PauseCheckOutage | null,
    private readonly log: (l: string) => void = (l) => console.log(l),
  ) {}

  /** No Sperre covering the call has a purpose: nothing to check, no IO. */
  static needsCheck(denies: CoveringDeny[]): boolean {
    return denies.some((d) => d.purpose !== null);
  }

  async evaluate(input: { userId: number; denies: CoveringDeny[]; call: CheckCall }): Promise<SperreResult> {
    const { denies } = input;
    if (denies.length === 0 || denies.some((d) => d.purpose === null)) return { kind: 'nopurpose' };
    const config = this.config;
    if (!config) return { kind: 'off' };
    const u = await prisma.user.findUnique({ where: { id: input.userId }, select: { pauseCheck: true } });
    if (u?.pauseCheck !== true) return { kind: 'off' };
    const t = Number.isFinite(this.threshold) && this.threshold > 0 && this.threshold <= 1 ? this.threshold : PAUSE_CHECK_THRESHOLD_DEFAULT;
    let last: SperreResult = { kind: 'error' };
    for (const d of denies) {
      const anchor =
        d.anchorAuditId === null
          ? null
          : await prisma.auditEntry.findFirst({
              where: { id: d.anchorAuditId, userId: input.userId },
              select: { toolName: true, arguments: true, upstream: { select: { name: true } } },
            });
      if (!anchor) return { kind: 'error' }; // nothing to compare with: refuse (not an outage)
      const state = sperreState(d.purpose!, { upstream: anchor.upstream?.name ?? input.call.upstream, tool: anchor.toolName, args: parseArgs(anchor.arguments) }, input.call);
      const r = await withTimeout(config.timeoutMs, async (signal) => parseNoul(await config.client.ask(state, sperreQuestions(), signal), SPERRE_QUESTION));
      if ('error' in r) {
        console.warn(`sperre check failed (${r.timedOut ? 'timeout' : r.error instanceof Error ? r.error.name : 'unknown'}), call refused`);
        this.outage?.failed(input.userId);
        return { kind: 'error' };
      }
      this.outage?.cleared(input.userId);
      this.log(`sperre check: p(outside)=${r.value.toFixed(3)}`);
      if (r.value < t) return { kind: 'inside', score: r.value, purpose: d.purpose! };
      last = { kind: 'outside', score: r.value, purpose: d.purpose! };
    }
    return last;
  }
}
