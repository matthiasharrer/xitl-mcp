// Pure time and text helpers for held calls (ADR-0004, TC-30, TC-37). No I/O,
// no clock reads: every "now" is passed in. Unit tested in budget.test.ts.

/** Claude.ai gives up on a tool call after about 300 s: approval wait AND the
 * upstream call together must fit in this, counted from receipt (TC-37). */
export const CALL_BUDGET_MS = 300_000;

/** Below this much time left, an approved call is not forwarded at all (it
 * would only time out at the upstream and the agent would get nothing useful):
 * it is denied as a timeout instead. */
export const MIN_UPSTREAM_MS = 5_000;

/** Default approval wait (ADR-0004: 5 minutes, then deny). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/** `APPROVAL_TIMEOUT_MS` from the environment (e2e sets a few seconds), else
 * the default. Anything that isn't a positive integer is ignored. */
export function approvalTimeoutFromEnv(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const n = Number(raw.trim());
  return n > 0 ? n : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/** When a held call stops waiting: the configured timeout, but never so late
 * that less than MIN_UPSTREAM_MS of the budget would be left for the upstream. */
export function approvalDeadline(receivedAt: Date, timeoutMs: number): Date {
  const wait = Math.max(0, Math.min(timeoutMs, CALL_BUDGET_MS - MIN_UPSTREAM_MS));
  return new Date(receivedAt.getTime() + wait);
}

/** The upstream call's timeout for a call received at `receivedAt`, decided
 * (approved) by `now`: what is left of the budget, capped by `capMs` (the
 * normal per-call timeout). null = less than MIN_UPSTREAM_MS left: deny as a
 * timeout, do not forward. */
export function upstreamTimeoutMs(receivedAt: Date, now: Date, capMs: number): number | null {
  const left = receivedAt.getTime() + CALL_BUDGET_MS - now.getTime();
  if (!(left >= MIN_UPSTREAM_MS)) return null;
  return Math.min(capMs, left);
}

// ---- snooze ------------------------------------------------------------------

/** The longest snooze the API accepts (minutes). */
export const MAX_SNOOZE_MINUTES = 24 * 60;

const BERLIN = 'Europe/Berlin';

/** Europe/Berlin's offset from UTC at `at`, in ms (e.g. +2 h in summer). */
function berlinOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BERLIN,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The next local midnight in Europe/Berlin after `now` ("Heute" snooze). */
export function nextBerlinMidnight(now: Date): Date {
  const local = new Date(now.getTime() + berlinOffsetMs(now));
  // Midnight starting the next local day, expressed as if it were UTC…
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  // …then shifted by the offset in force at that moment (DST-safe: the
  // second pass uses the offset at the result itself).
  let guess = wall - berlinOffsetMs(new Date(wall));
  guess = wall - berlinOffsetMs(new Date(guess));
  return new Date(guess);
}

/** The snooze end for an approval, or null for "Einmal erlauben". */
export function snoozeUntil(now: Date, opts: { snoozeMinutes?: number; snoozeUntilMidnight?: boolean }): Date | null {
  if (opts.snoozeUntilMidnight) return nextBerlinMidnight(now);
  const m = opts.snoozeMinutes;
  if (typeof m === 'number' && Number.isInteger(m) && m > 0 && m <= MAX_SNOOZE_MINUTES) {
    return new Date(now.getTime() + m * 60_000);
  }
  return null;
}

// ---- push summary ------------------------------------------------------------

export const SUMMARY_MAX = 120;

function scalarText(v: unknown): string | null {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  return null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** One short German line for a push notification: the tool and its first
 * argument values ("add_item: Eier, 3"). Agent-controlled text, so it is
 * flattened to one line and truncated; it is shown, never interpreted. */
export function approvalSummary(tool: string, args: unknown): string {
  const values: string[] = [];
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const v of Object.values(args as Record<string, unknown>)) {
      const text = scalarText(v) ?? (Array.isArray(v) ? `[${v.length}]` : v && typeof v === 'object' ? '{…}' : null);
      if (text) values.push(text);
      if (values.join(', ').length >= SUMMARY_MAX) break;
    }
  }
  const head = truncate(tool.replace(/\s+/g, ' '), 60);
  return truncate(values.length > 0 ? `${head}: ${values.join(', ')}` : `${head} (ohne Argumente)`, SUMMARY_MAX);
}
