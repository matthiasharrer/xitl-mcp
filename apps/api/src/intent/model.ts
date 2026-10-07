// The intent model seam (ADR-0003, ADR-0025 §7): an interface, the real
// llama.cpp (OpenAI-compatible) implementation, and a deterministic stub for
// e2e. Selected by env in `intentModelFromEnv`:
//
//   INTENT_LLM_URL      base URL (e.g. http://llama-cpp.ai.svc.cluster.local:8080);
//                       unset = feature off. `/v1/chat/completions` is appended
//                       unless the URL already ends in `/chat/completions`.
//   INTENT_LLM_MODEL    model id (default `qwen`, a llama.cpp alias so the
//                       version isn't hardcoded); the name the server answers
//                       with is what is stored per call (intentModel)
//   INTENT_LLM_API_KEY  optional bearer; never logged
//   INTENT_LLM_TIMEOUT_MS  request timeout, at most (and default) 60 s; e2e
//                       shortens it for the "hang" case
//   INTENT_LLM_THINK_BUDGET  thinking tokens per request (default 128, max
//                       INTENT_THINK_BUDGET_MAX, 0 = thinking off; anything
//                       unparsable or negative = the default). Sent as
//                       `thinking_budget_tokens` (llama.cpp's per-request
//                       field; `reasoning_budget` is ignored by it, measured
//                       on b11429). Only `message.content` is read; the
//                       reasoning text is dropped, never parsed or stored.
//   INTENT_LLM_STUB=1   the stub instead (e2e only); INTENT_LLM_STUB_LOG=<file>
//                       appends each request's messages as a JSON line.
//
// The request goes through outboundFetch (ADR-0020) with exactly the URL's
// host:port as the one extra allowed internal address; redirects are refused
// there. Size-capped response; the timeout is the caller's signal (queue.ts).
import fs from 'node:fs';
import { systemClock, type Clock } from '../lib/clock.js';
import { limitResponse } from '../lib/limitedResponse.js';
import {
  INTENT_ANSWER_MAX_TOKENS,
  INTENT_REQUEST_TIMEOUT_MS,
  INTENT_THINK_BUDGET_DEFAULT,
  INTENT_THINK_BUDGET_MAX,
  MAX_INTENT_RESPONSE_BYTES,
} from '../lib/limits.js';
import { outboundFetch, upstreamAllowance, type AllowEntry } from '../lib/outbound.js';
import { blockOf, type ChatMessage } from './prompt.js';
import { DRAFT_SYSTEM_PROMPT } from '../auto/draft.js';

export { blockOf };

export interface IntentAnswer {
  /** The assistant's raw answer text. */
  text: string;
  /** The model that actually answered (the response's `model`), if known. */
  model: string | null;
}

export interface IntentModel {
  /** The configured model; stored when the answer names none. */
  readonly name: string;
  /** Rejects on any failure or abort. */
  complete(messages: ChatMessage[], signal: AbortSignal): Promise<IntentAnswer>;
}

/** A llama.cpp alias (Matthias, 2026-10-06): services don't pin the version. */
export const DEFAULT_INTENT_MODEL = 'qwen';

/** A model name from the response: one line, ≤ 100 chars, or null. */
function modelName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, 100) : null;
}

/** The chat-completions URL and the one internal address it may reach. */
export function llamaEndpoint(raw: string): { endpoint: URL; allowance: AllowEntry[] } {
  const base = new URL(raw.trim());
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('INTENT_LLM_URL must be http(s)');
  if (base.username || base.password) throw new Error('INTENT_LLM_URL must not carry credentials (use INTENT_LLM_API_KEY)');
  const endpoint = new URL(base.href);
  endpoint.search = '';
  endpoint.hash = '';
  if (!/\/chat\/completions\/?$/.test(endpoint.pathname)) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/chat/completions`;
  }
  // Exactly this host:port (default port filled in), the per-upstream
  // exception's shape (ADR-0020).
  return { endpoint, allowance: upstreamAllowance({ url: endpoint.href, allowInternal: true }) };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface LlamaOptions {
  url: string;
  model?: string;
  apiKey?: string;
  clock?: Clock;
  /** Info log (numbers only). */
  log?: (line: string) => void;
  /** outboundFetch, replaceable in tests (e.g. to pass `allow: []`). */
  fetch?: typeof outboundFetch;
  /** Thinking tokens (intentThinkBudgetFromEnv); 0 = off. Default 128. */
  thinkBudget?: number;
}

/** INTENT_LLM_THINK_BUDGET: an integer 0…max (above: the max); anything else
 * (unset, garbage, negative, fractional) is the default. */
export function intentThinkBudgetFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return INTENT_THINK_BUDGET_DEFAULT;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return INTENT_THINK_BUDGET_DEFAULT;
  return Math.min(n, INTENT_THINK_BUDGET_MAX);
}

/** The request body (TC-117). Thinking with a budget, JSON mode kept (without
 * it 2 of 18 answers were broken, 2026-10-06), room for budget + answer. */
export function requestBody(model: string, messages: ChatMessage[], thinkBudget: number): Record<string, unknown> {
  const budget = Number.isInteger(thinkBudget) && thinkBudget > 0 ? Math.min(thinkBudget, INTENT_THINK_BUDGET_MAX) : 0;
  return {
    model,
    messages,
    max_tokens: INTENT_ANSWER_MAX_TOKENS + budget,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: budget > 0 },
    ...(budget > 0 ? { thinking_budget_tokens: budget } : {}),
    response_format: { type: 'json_object' },
  };
}

export function llamaModel(opts: LlamaOptions): IntentModel {
  const { endpoint, allowance } = llamaEndpoint(opts.url);
  const model = opts.model?.trim() || DEFAULT_INTENT_MODEL;
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? ((l: string) => console.log(l));
  const doFetch = opts.fetch ?? outboundFetch;
  const apiKey = opts.apiKey?.trim() || null;
  const thinkBudget = opts.thinkBudget ?? INTENT_THINK_BUDGET_DEFAULT;
  return {
    name: model.slice(0, 100),
    async complete(messages, signal) {
      const started = clock.now().getTime();
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await doFetch(
        endpoint,
        {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify(requestBody(model, messages, thinkBudget)),
        },
        { alsoAllow: allowance },
      );
      const limited = await limitResponse(res, MAX_INTENT_RESPONSE_BYTES);
      if (!res.ok) {
        await limited.body?.cancel().catch(() => {});
        throw new Error(`intent model answered HTTP ${res.status}`);
      }
      const body = JSON.parse(await limited.text()) as {
        model?: unknown;
        // `reasoning_content` (the thinking) is deliberately not read.
        choices?: { message?: { content?: unknown } }[];
        timings?: { prompt_n?: unknown; cache_n?: unknown };
      };
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('intent model answer without content');
      // Numbers only: never the prompt, the answer or the key.
      const ms = clock.now().getTime() - started;
      log(`intent: model answered in ${ms} ms (prompt_n=${num(body.timings?.prompt_n) ?? '?'}, cache_n=${num(body.timings?.cache_n) ?? '?'})`);
      return { text: content, model: modelName(body.model) };
    },
  };
}

// ---- stub (e2e) ------------------------------------------------------------------

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

/**
 * Deterministic stand-in (docs/testing.md, "Intent summary"). By the last
 * turn's `arguments.__stub`: "fail" rejects, "hang" waits for the abort,
 * "garbage" answers non-JSON, "harmlos" answers risk read, "slow" answers
 * normally after 1.5 s, "long" answers a ~400-char intent (layout checks);
 * otherwise {"title":"Stub-Titel <tool>","intent":"Stub: <tool>","risk":"write"}.
 */
export function stubModel(opts: { log?: string } = {}): IntentModel {
  return {
    name: 'stub',
    async complete(messages, signal) {
      if (opts.log) fs.appendFileSync(opts.log, JSON.stringify({ messages }) + '\n');
      // ADR-0030 "Vorschlag": a draft request (tests only). A tool whose
      // description says `__stub:fail` makes it fail.
      if (messages[0]?.content === DRAFT_SYSTEM_PROMPT) {
        const user = messages[1]?.content ?? '';
        if (user.includes('__stub:fail')) throw new Error('stub: fail');
        const names = [...user.matchAll(/"tool":"([^"]+)"/g)].map((m) => m[1]).join(', ');
        return { text: JSON.stringify({ regel: `Stub-Vorschlag: ${names} lesen ist ok.` }), model: null };
      }
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const data = last ? blockOf(last.content) : null;
      const tool = typeof data?.tool === 'string' ? data.tool : '?';
      const args = data?.arguments as Record<string, unknown> | null | undefined;
      const mode = args && typeof args === 'object' ? args.__stub : undefined;
      if (mode === 'fail') throw new Error('stub: fail');
      if (mode === 'hang') {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
      if (mode === 'garbage') return { text: 'Das ist kein JSON.', model: null };
      if (mode === 'slow') await sleep(1500, signal);
      const intent = mode === 'long' ? `Stub: ${tool}. ${'Eine sehr lange Zusammenfassung mit Überlänge, '.repeat(8)}Ende.` : `Stub: ${tool}`;
      return { text: JSON.stringify({ title: `Stub-Titel ${tool}`, intent, risk: mode === 'harmlos' ? 'read' : 'write' }), model: null };
    },
  };
}

/** The configured model, or null (feature off). Logs which, never the key. */
export function intentModelFromEnv(env: NodeJS.ProcessEnv = process.env): IntentModel | null {
  if (env.INTENT_LLM_STUB === '1') {
    console.warn('intent: using the STUB model (INTENT_LLM_STUB=1, tests only)');
    return stubModel({ log: env.INTENT_LLM_STUB_LOG || undefined });
  }
  const url = env.INTENT_LLM_URL?.trim();
  if (!url) return null;
  try {
    const thinkBudget = intentThinkBudgetFromEnv(env.INTENT_LLM_THINK_BUDGET);
    const m = llamaModel({ url, model: env.INTENT_LLM_MODEL, apiKey: env.INTENT_LLM_API_KEY, thinkBudget });
    console.log(`intent: summaries on, model ${m.name} at ${llamaEndpoint(url).endpoint.host}, thinking ${thinkBudget > 0 ? `${thinkBudget} tokens` : 'off'}`);
    return m;
  } catch (e) {
    console.error(`intent: INTENT_LLM_URL unusable, summaries off (${e instanceof Error ? e.message : 'invalid'})`);
    return null;
  }
}

/** INTENT_LLM_TIMEOUT_MS: 1 ms … the 60 s default (anything else: the default). */
export function intentTimeoutFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= INTENT_REQUEST_TIMEOUT_MS ? n : INTENT_REQUEST_TIMEOUT_MS;
}
