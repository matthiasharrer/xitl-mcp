// The AI check seam (ADR-0003, ADR-0029 §8): the `PauseCheck` interface, the
// real Clef implementation (llama.cpp `/v1/systemone`), strict answer
// validation and the pure verdict. Config by env only:
//
//   PAUSE_CHECK_URL         Clef base URL (e.g. http://<clef-service>:8080);
//                           unset/empty = feature off: no check, no switch,
//                           no outbound request. `/v1/systemone` is appended
//                           unless the URL already ends in it.
//   PAUSE_CHECK_THRESHOLD   p(gleich) at or above it forwards (default 0.8);
//                           anything not a number in (0, 1] = the default,
//                           logged.
//   PAUSE_CHECK_MODEL       optional `model` field (a llama.cpp alias, e.g.
//                           `clef`); unset = the field is omitted (the server
//                           serves one model). Never hard-coded.
//   PAUSE_CHECK_TIMEOUT_MS  per request (default 10 000, 1 … 60 000; else the
//                           default).
//
// There is no in-process stub: e2e points PAUSE_CHECK_URL at a fake Clef
// server (e2e/support/fakeClef.ts), so the real client, its validation and
// its timeout are what the e2e cases exercise. The fake's verdict marker in
// the call arguments is read ONLY by that fake; nothing here looks at it.
//
// Transport (outboundFetch with the host allowance, no credentials, size
// cap) is shared with the other Clef features: clef/client.ts.
import { PAUSE_CHECK_THRESHOLD_DEFAULT } from '../lib/limits.js';
import type { outboundFetch } from '../lib/outbound.js';
import { clefClient, clefEndpoint, InvalidAnswer, timeoutFromEnv } from '../clef/client.js';
import { OPTIONS, QUESTION, requestBody, type RichtungChoice } from './prompt.js';

// The transport is shared with the other Clef features (clef/client.ts).
export { clefEndpoint, InvalidAnswer, timeoutFromEnv };

/** A validated answer: every probability finite in [0, 1], `gleich` present. */
export interface PauseCheckAnswer {
  choice: RichtungChoice;
  probabilities: Partial<Record<RichtungChoice, number>> & { gleich: number };
}

export interface PauseCheck {
  /** Rejects on any failure, abort or invalid answer (= "error", fail closed). */
  check(state: string, signal: AbortSignal, withPurpose?: boolean): Promise<PauseCheckAnswer>;
}

const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Strict: the `richtung` answer with a choice among the three options and a
 * probability map whose keys are among them, `gleich` present, every value a
 * finite number in [0, 1]. Anything else throws InvalidAnswer. */
export function parseAnswer(body: unknown): PauseCheckAnswer {
  const answers = body && typeof body === 'object' ? (body as Record<string, unknown>).answers : undefined;
  const a = answers && typeof answers === 'object' ? (answers as Record<string, unknown>)[QUESTION] : undefined;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new InvalidAnswer('no richtung answer');
  const { choice, probabilities } = a as Record<string, unknown>;
  if (typeof choice !== 'string' || !(OPTIONS as readonly string[]).includes(choice)) throw new InvalidAnswer('choice not an option');
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) throw new InvalidAnswer('no probabilities');
  const probs: Partial<Record<RichtungChoice, number>> = {};
  for (const [k, v] of Object.entries(probabilities as Record<string, unknown>)) {
    if (!(OPTIONS as readonly string[]).includes(k)) throw new InvalidAnswer('unknown option');
    if (!isProb(v)) throw new InvalidAnswer('probability not in [0,1]');
    probs[k as RichtungChoice] = v;
  }
  if (!isProb(probs.gleich)) throw new InvalidAnswer('no gleich probability');
  return { choice: choice as RichtungChoice, probabilities: probs as PauseCheckAnswer['probabilities'] };
}

export type Deviation = Exclude<RichtungChoice, 'gleich'>;

export type Verdict = { kind: 'match'; score: number } | { kind: 'mismatch'; score: number; deviation: Deviation };

/** p(gleich) ≥ threshold -> match. Otherwise a mismatch, labelled with the
 * stronger of the two deviations (ties: richtungswechsel). Pure. A threshold
 * that is not a number in (0, 1] is the default (never "everything passes"). */
export function verdict(answer: PauseCheckAnswer, threshold: number): Verdict {
  const t = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : PAUSE_CHECK_THRESHOLD_DEFAULT;
  const score = answer.probabilities.gleich;
  if (isProb(score) && score >= t) return { kind: 'match', score };
  const w = answer.probabilities.richtungswechsel ?? 0;
  const x = answer.probabilities.ausweitung ?? 0;
  return { kind: 'mismatch', score: isProb(score) ? score : 0, deviation: x > w ? 'ausweitung' : 'richtungswechsel' };
}

export function clefCheck(opts: { url: string; model?: string; fetch?: typeof outboundFetch }): PauseCheck {
  const client = clefClient(opts);
  const questions = (withPurpose: boolean) => requestBody('', client.model, withPurpose).questions as Parameters<typeof client.ask>[1];
  return {
    async check(state, signal, withPurpose = false) {
      return parseAnswer(await client.ask(state, questions(withPurpose), signal));
    },
  };
}

export interface PauseCheckConfig {
  check: PauseCheck;
  threshold: number;
  timeoutMs: number;
  /** host[:port] for log lines (never the path). */
  host: string;
}

/** PAUSE_CHECK_THRESHOLD: a number in (0, 1]; anything else the default (logged). */
export function thresholdFromEnv(raw: string | undefined, warn: (l: string) => void = (l) => console.warn(l)): number {
  if (raw === undefined || raw.trim() === '') return PAUSE_CHECK_THRESHOLD_DEFAULT;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    warn(`pause check: PAUSE_CHECK_THRESHOLD unusable, using ${PAUSE_CHECK_THRESHOLD_DEFAULT}`);
    return PAUSE_CHECK_THRESHOLD_DEFAULT;
  }
  return n;
}

/** The configured check, or null (feature off). Logs which, never the path. */
export function pauseCheckFromEnv(env: NodeJS.ProcessEnv = process.env): PauseCheckConfig | null {
  const url = env.PAUSE_CHECK_URL?.trim();
  if (!url) return null;
  try {
    const { endpoint } = clefEndpoint(url);
    const threshold = thresholdFromEnv(env.PAUSE_CHECK_THRESHOLD);
    const timeoutMs = timeoutFromEnv(env.PAUSE_CHECK_TIMEOUT_MS);
    console.log(`pause check: on, Clef at ${endpoint.host}, threshold ${threshold}, timeout ${timeoutMs} ms`);
    return { check: clefCheck({ url, model: env.PAUSE_CHECK_MODEL }), threshold, timeoutMs, host: endpoint.host };
  } catch (e) {
    // Unusable URL: off, like unset. Pauses stay blind (today's behaviour);
    // the admin sees why in the log.
    console.error(`pause check: PAUSE_CHECK_URL unusable, check off (${e instanceof Error ? e.message : 'invalid'})`);
    return null;
  }
}
