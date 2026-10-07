// The one Clef endpoint (llama.cpp `/v1/systemone`) shared by every Clef
// feature: the AI check of allow pauses (ADR-0029, pausecheck/), the AUTO
// policy (ADR-0030, auto/) and the advisory review hint of new and changed
// tools (ADR-0031, toolhint/). One config by env (read in clefFromEnv):
//
//   PAUSE_CHECK_URL         Clef base URL; unset/empty/unusable = every Clef
//                           feature off, no outbound request. `/v1/systemone`
//                           is appended unless the URL already ends in it.
//   PAUSE_CHECK_MODEL       optional `model` field (a llama.cpp alias such as
//                           `clef`); unset = omitted. Never hard-coded.
//   PAUSE_CHECK_TIMEOUT_MS  per request (default 10 000, 1 … 60 000).
//
// (The names keep their ADR-0029 prefix: renaming deployed env is not worth it.)
//
// This file is transport only: POST one body, size-capped, strict about HTTP
// status and JSON. What a question's answer must look like is checked by the
// caller (parseNoul / parseChoice here, pausecheck/check.ts parseAnswer), and
// anything off is an error there (fail closed).
//
// The request goes through outboundFetch (ADR-0020) with exactly the URL's
// host:port as the one extra allowed internal address; redirects are refused
// there. No credentials: a URL with userinfo is refused.
import { limitResponse } from '../lib/limitedResponse.js';
import { MAX_PAUSE_CHECK_RESPONSE_BYTES, PAUSE_CHECK_TIMEOUT_DEFAULT_MS, PAUSE_CHECK_TIMEOUT_MAX_MS } from '../lib/limits.js';
import { outboundFetch, upstreamAllowance, type AllowEntry } from '../lib/outbound.js';

export class InvalidAnswer extends Error {
  override name = 'InvalidAnswer';
}

/** One named question of a systemone request. */
export type ClefQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string };

/** The systemone URL and the one internal address it may reach. */
export function clefEndpoint(raw: string): { endpoint: URL; allowance: AllowEntry[] } {
  const base = new URL(raw.trim());
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('PAUSE_CHECK_URL must be http(s)');
  if (base.username || base.password) throw new Error('PAUSE_CHECK_URL must not carry credentials');
  const endpoint = new URL(base.href);
  endpoint.search = '';
  endpoint.hash = '';
  if (!/\/v1\/systemone\/?$/.test(endpoint.pathname)) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/systemone`;
  }
  return { endpoint, allowance: upstreamAllowance({ url: endpoint.href, allowInternal: true }) };
}

export interface ClefClient {
  /** The configured model alias (or undefined: field omitted). */
  readonly model: string | undefined;
  /** POSTs `{model?, state, questions}`; resolves to the parsed JSON body.
   * Rejects on HTTP errors, non-JSON, size overrun, abort. */
  ask(state: string, questions: Record<string, ClefQuestion>, signal: AbortSignal): Promise<unknown>;
}

/** The systemone body. `model` only when configured. */
export function clefBody(state: string, questions: Record<string, ClefQuestion>, model?: string): Record<string, unknown> {
  return { ...(model ? { model } : {}), state, questions };
}

export function clefClient(opts: { url: string; model?: string; fetch?: typeof outboundFetch }): ClefClient {
  const { endpoint, allowance } = clefEndpoint(opts.url);
  const doFetch = opts.fetch ?? outboundFetch;
  const model = opts.model?.trim().slice(0, 100) || undefined;
  return {
    model,
    async ask(state, questions, signal) {
      const res = await doFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          signal,
          body: JSON.stringify(clefBody(state, questions, model)),
        },
        { alsoAllow: allowance },
      );
      const limited = await limitResponse(res, MAX_PAUSE_CHECK_RESPONSE_BYTES);
      if (!res.ok) {
        await limited.body?.cancel().catch(() => {});
        throw new Error(`clef answered HTTP ${res.status}`);
      }
      try {
        return JSON.parse(await limited.text()) as unknown;
      } catch {
        throw new InvalidAnswer('not JSON');
      }
    },
  };
}

const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** The answer object of question `q`, or InvalidAnswer. */
function answerOf(body: unknown, q: string): Record<string, unknown> {
  const answers = body && typeof body === 'object' ? (body as Record<string, unknown>).answers : undefined;
  const a = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>)[q] : undefined;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new InvalidAnswer(`no ${q} answer`);
  return a as Record<string, unknown>;
}

/** Strict: `answers[q].noul` is a finite number in [0, 1]. */
export function parseNoul(body: unknown, q: string): number {
  const a = answerOf(body, q);
  if (a.type !== undefined && a.type !== 'noul') throw new InvalidAnswer('not a noul answer');
  if (!isProb(a.noul)) throw new InvalidAnswer('noul not in [0,1]');
  return a.noul;
}

/** Strict: `answers[q]` has a `choice` among `options` and a probability map
 * whose keys are among them, each finite in [0, 1], the chosen one present. */
export function parseChoice<O extends string>(body: unknown, q: string, options: readonly O[]): { choice: O; probabilities: Partial<Record<O, number>> } {
  const a = answerOf(body, q);
  const { choice, probabilities } = a;
  if (typeof choice !== 'string' || !(options as readonly string[]).includes(choice)) throw new InvalidAnswer('choice not an option');
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) throw new InvalidAnswer('no probabilities');
  const probs: Partial<Record<O, number>> = {};
  for (const [k, v] of Object.entries(probabilities as Record<string, unknown>)) {
    if (!(options as readonly string[]).includes(k)) throw new InvalidAnswer('unknown option');
    if (!isProb(v)) throw new InvalidAnswer('probability not in [0,1]');
    probs[k as O] = v;
  }
  if (!isProb(probs[choice as O])) throw new InvalidAnswer('no probability for the choice');
  return { choice: choice as O, probabilities: probs };
}

/** PAUSE_CHECK_TIMEOUT_MS: an integer 1 … 60 000; anything else the default. */
export function timeoutFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= PAUSE_CHECK_TIMEOUT_MAX_MS ? n : PAUSE_CHECK_TIMEOUT_DEFAULT_MS;
}

export interface ClefConfig {
  client: ClefClient;
  timeoutMs: number;
  /** host[:port] for log lines (never the path). */
  host: string;
}

/** The configured Clef, or null (every Clef feature off). Never logs the path. */
export function clefFromEnv(env: NodeJS.ProcessEnv = process.env, log: (l: string) => void = () => {}): ClefConfig | null {
  const url = env.PAUSE_CHECK_URL?.trim();
  if (!url) return null;
  try {
    const { endpoint } = clefEndpoint(url);
    return { client: clefClient({ url, model: env.PAUSE_CHECK_MODEL }), timeoutMs: timeoutFromEnv(env.PAUSE_CHECK_TIMEOUT_MS), host: endpoint.host };
  } catch (e) {
    log(`clef: PAUSE_CHECK_URL unusable, Clef features off (${e instanceof Error ? e.message : 'invalid'})`);
    return null;
  }
}

/** Runs `fn` with an AbortSignal that fires after `timeoutMs`; the result is
 * an error at the deadline even if `fn` ignores the signal. */
export async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<{ value: T } | { error: unknown; timedOut: boolean }> {
  const ctrl = new AbortController();
  const aborted = new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  aborted.catch(() => {});
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    return { value: await Promise.race([fn(ctrl.signal), aborted]) };
  } catch (e) {
    return { error: e, timedOut: ctrl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}
