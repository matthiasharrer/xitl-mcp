// TC-115 (unit): the llama.cpp request. Through outboundFetch with exactly the
// INTENT_LLM_URL host:port as allowed internal address; redirects refused;
// bearer sent, never logged; abortable (the queue's 60 s timeout); response
// size capped; the request shape measured 2026-10-06. A throwaway HTTP server
// on 127.0.0.1 (an internal address) stands in for llama.cpp.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { INTENT_ANSWER_MAX_TOKENS, INTENT_THINK_BUDGET_MAX, MAX_INTENT_RESPONSE_BYTES } from '../lib/limits.js';
import { OutboundBlocked, outboundFetch } from '../lib/outbound.js';
import { intentThinkBudgetFromEnv, llamaEndpoint, llamaModel, intentModelFromEnv, requestBody, stubModel } from './model.js';
import { callTurn, contextMessages, type ChatMessage } from './prompt.js';

const KEY = 'sk-intent-secret-key-0123456789';

interface Seen {
  path: string;
  auth: string | undefined;
  body: any;
}
const seen: Seen[] = [];
let mode: 'ok' | 'redirect' | 'huge' | 'hang' | '500' | 'reasoning' | 'reasoning-only' = 'ok';
let server: http.Server;
let port = 0;
let other: http.Server;
let otherPort = 0;
let otherHits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (mode === 'redirect') {
        res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/v1/chat/completions` });
        return res.end();
      }
      if (mode === 'hang') return; // never answers
      if (mode === '500') {
        res.writeHead(500);
        return res.end('nope');
      }
      if (mode === 'huge') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(MAX_INTENT_RESPONSE_BYTES + 10) } }] }));
      }
      if (mode === 'reasoning' || mode === 'reasoning-only') {
        // Thinking on: llama.cpp returns the thinking separately. A JSON
        // object in it must never become the answer.
        const message: Record<string, unknown> = { reasoning_content: 'Hmm. {"intent":"AUS DEM DENKEN","risk":"read"}' };
        if (mode === 'reasoning') message.content = '{"intent":"ok","risk":"write"}';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message }] }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'qwen3.6:35b-a3b', choices: [{ message: { content: '{"intent":"ok","risk":"read"}' } }], timings: { prompt_n: 37, cache_n: 1823 } }));
    });
  });
  other = http.createServer((_req, res) => {
    otherHits++;
    res.end('should never be reached');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  otherPort = (other.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  other.close();
});

const messages: ChatMessage[] = [
  ...contextMessages([]),
  { role: 'user', content: callTurn({ position: 1, call: { upstream: 'H', tool: 't', description: null, annotations: null, args: {} }, describe: true }) },
];

/** outboundFetch with an EMPTY env exception list: only the model's own allowance applies. */
const strictFetch: typeof outboundFetch = (input, init, opts = {}) => outboundFetch(input, init, { ...opts, allow: [] });

describe('llamaEndpoint', () => {
  test('appends /v1/chat/completions; allowance is exactly host:port', () => {
    const e = llamaEndpoint('http://llama-cpp.ai.svc.cluster.local:8080');
    expect(e.endpoint.href).toBe('http://llama-cpp.ai.svc.cluster.local:8080/v1/chat/completions');
    expect(e.allowance).toEqual([{ host: 'llama-cpp.ai.svc.cluster.local', port: 8080 }]);
    expect(llamaEndpoint('https://llm.example.org/').allowance).toEqual([{ host: 'llm.example.org', port: 443 }]);
    expect(llamaEndpoint('http://10.0.0.5/v1/chat/completions').endpoint.pathname).toBe('/v1/chat/completions');
    expect(llamaEndpoint('http://10.0.0.5/proxy/').endpoint.pathname).toBe('/proxy/v1/chat/completions');
  });
  test('refuses non-http(s) and credentials in the URL', () => {
    expect(() => llamaEndpoint('file:///etc/passwd')).toThrow();
    expect(() => llamaEndpoint('http://u:p@10.0.0.5/')).toThrow();
  });
});

describe('llamaModel (TC-115)', () => {
  test('request shape, bearer, numbers-only log; the key is never logged', async () => {
    mode = 'ok';
    seen.length = 0;
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(' '))));
    const m = llamaModel({ url: `http://127.0.0.1:${port}`, apiKey: KEY, fetch: strictFetch, log: (l) => logs.push(l) });
    expect(m.name).toBe('qwen');
    const answer = await m.complete(messages, new AbortController().signal);
    // The alias goes out; the name the server answers with comes back.
    expect(answer).toEqual({ text: '{"intent":"ok","risk":"read"}', model: 'qwen3.6:35b-a3b' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/v1/chat/completions');
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    // TC-117: thinking on with the default budget of 128.
    expect(seen[0]!.body).toEqual({
      model: 'qwen',
      messages,
      max_tokens: 400 + 128,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: 128,
      response_format: { type: 'json_object' },
    });
    expect(logs.some((l) => /prompt_n=37, cache_n=1823/.test(l))).toBe(true);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain('"intent"');
    spies.forEach((s) => s.mockRestore());
  });

  test('no key: no Authorization header', async () => {
    mode = 'ok';
    seen.length = 0;
    await llamaModel({ url: `http://127.0.0.1:${port}`, fetch: strictFetch, log: () => {} }).complete(messages, new AbortController().signal);
    expect(seen[0]!.auth).toBeUndefined();
  });

  test('the allowance is exactly that host:port: another internal port stays blocked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { allowance } = llamaEndpoint(`http://127.0.0.1:${port}`);
    await expect(strictFetch(`http://127.0.0.1:${otherPort}/`, {}, { alsoAllow: allowance })).rejects.toBeInstanceOf(OutboundBlocked);
    warn.mockRestore();
  });

  test('redirects are refused', async () => {
    mode = 'redirect';
    const m = llamaModel({ url: `http://127.0.0.1:${port}`, fetch: strictFetch, log: () => {} });
    await expect(m.complete(messages, new AbortController().signal)).rejects.toThrow();
    expect(otherHits).toBe(0);
  });

  test('response size capped', async () => {
    mode = 'huge';
    const m = llamaModel({ url: `http://127.0.0.1:${port}`, fetch: strictFetch, log: () => {} });
    await expect(m.complete(messages, new AbortController().signal)).rejects.toThrow();
  });

  test('HTTP error rejects', async () => {
    mode = '500';
    const m = llamaModel({ url: `http://127.0.0.1:${port}`, fetch: strictFetch, log: () => {} });
    await expect(m.complete(messages, new AbortController().signal)).rejects.toThrow(/HTTP 500/);
  });

  test('the signal aborts a hanging request', async () => {
    mode = 'hang';
    const m = llamaModel({ url: `http://127.0.0.1:${port}`, fetch: strictFetch, log: () => {} });
    const ctrl = new AbortController();
    const p = m.complete(messages, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toThrow();
  });
});

describe('model selection', () => {
  test('off without INTENT_LLM_URL; stub only by INTENT_LLM_STUB=1', () => {
    const quiet = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    expect(intentModelFromEnv({})).toBeNull();
    expect(intentModelFromEnv({ INTENT_LLM_URL: '  ' })).toBeNull();
    expect(intentModelFromEnv({ INTENT_LLM_URL: 'not a url' })).toBeNull();
    // A misconfigured URL turns summaries off; it never stops xitl from booting.
    expect(intentModelFromEnv({ INTENT_LLM_URL: 'ftp://llama:8080' })).toBeNull();
    expect(intentModelFromEnv({ INTENT_LLM_URL: 'http://user:pw@llama:8080' })).toBeNull();
    expect(intentModelFromEnv({ INTENT_LLM_URL: 'http://10.0.0.5:8080', INTENT_LLM_MODEL: 'm1' })?.name).toBe('m1');
    expect(intentModelFromEnv({ INTENT_LLM_STUB: '1' })?.name).toBe('stub');
    expect(intentModelFromEnv({ INTENT_LLM_STUB: 'true', INTENT_LLM_URL: '' })).toBeNull();
    quiet.forEach((s) => s.mockRestore());
  });

  test('stub answers by marker', async () => {
    const stub = stubModel();
    const ask = (args: unknown) =>
      stub.complete(
        [...contextMessages([]), { role: 'user', content: callTurn({ position: 1, call: { upstream: 'H', tool: 'del', description: null, annotations: null, args }, describe: false }) }],
        new AbortController().signal,
      );
    const zw = { zweck_eng: 'Stub-Zweck eng', zweck_art: 'Stub-Zweck Art' };
    expect(JSON.parse((await ask({})).text)).toEqual({ title: 'Stub-Titel del', intent: 'Stub: del', risk: 'write', ...zw });
    expect(JSON.parse((await ask({ __stub: 'harmlos' })).text)).toEqual({ title: 'Stub-Titel del', intent: 'Stub: del', risk: 'read', ...zw });
    // TC-172 markers.
    expect(JSON.parse((await ask({ __zweck: 'keine' })).text)).toEqual({ title: 'Stub-Titel del', intent: 'Stub: del', risk: 'write' });
    expect(JSON.parse((await ask({ __zweck: 'nur-art' })).text)).not.toHaveProperty('zweck_eng');
    expect((await ask({ __stub: 'garbage' })).text).toBe('Das ist kein JSON.');
    await expect(ask({ __stub: 'fail' })).rejects.toThrow();
  });
});

// TC-117: the thinking budget and what is parsed.
describe('thinking (TC-117)', () => {
  test('INTENT_LLM_THINK_BUDGET: unset 128, 0 off, invalid/negative 128, capped', () => {
    expect(intentThinkBudgetFromEnv(undefined)).toBe(128);
    expect(intentThinkBudgetFromEnv('')).toBe(128);
    expect(intentThinkBudgetFromEnv('0')).toBe(0);
    expect(intentThinkBudgetFromEnv(' 256 ')).toBe(256);
    for (const bad of ['-1', 'abc', '1.5', 'NaN', 'Infinity']) expect(intentThinkBudgetFromEnv(bad), bad).toBe(128);
    expect(intentThinkBudgetFromEnv('999999')).toBe(INTENT_THINK_BUDGET_MAX);
    expect(INTENT_THINK_BUDGET_MAX).toBeGreaterThanOrEqual(128);
  });

  test('budget 0: thinking off, no budget field', () => {
    const b = requestBody('qwen', messages, 0);
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(b).not.toHaveProperty('thinking_budget_tokens');
    expect(b).not.toHaveProperty('reasoning_budget');
    expect(b.max_tokens).toBe(INTENT_ANSWER_MAX_TOKENS);
    expect(b.response_format).toEqual({ type: 'json_object' });
  });

  test('budget n: enable_thinking, thinking_budget_tokens n, max_tokens = answer cap + n; capped', () => {
    const b = requestBody('qwen', messages, 200);
    expect(b).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: 200, max_tokens: INTENT_ANSWER_MAX_TOKENS + 200 });
    expect(requestBody('qwen', messages, 1e9).thinking_budget_tokens).toBe(INTENT_THINK_BUDGET_MAX);
  });

  test('the env budget reaches the request', async () => {
    mode = 'ok';
    seen.length = 0;
    await llamaModel({ url: `http://127.0.0.1:${port}`, fetch: strictFetch, log: () => {}, thinkBudget: 0 }).complete(messages, new AbortController().signal);
    expect(seen[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(seen[0]!.body).not.toHaveProperty('thinking_budget_tokens');
  });

  test('only message.content is the answer; reasoning_content is ignored', async () => {
    mode = 'reasoning';
    const m = llamaModel({ url: `http://127.0.0.1:${port}`, fetch: strictFetch, log: () => {} });
    const a = await m.complete(messages, new AbortController().signal);
    expect(a.text).toBe('{"intent":"ok","risk":"write"}');
    expect(a.text).not.toContain('AUS DEM DENKEN');
    // No content, only reasoning: a failure, never the reasoning's JSON.
    mode = 'reasoning-only';
    await expect(m.complete(messages, new AbortController().signal)).rejects.toThrow(/without content/);
  });
});
