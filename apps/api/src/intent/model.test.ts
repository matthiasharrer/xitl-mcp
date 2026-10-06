// TC-115 (unit): the llama.cpp request. Through outboundFetch with exactly the
// INTENT_LLM_URL host:port as allowed internal address; redirects refused;
// bearer sent, never logged; abortable (the queue's 60 s timeout); response
// size capped; the request shape measured 2026-10-06. A throwaway HTTP server
// on 127.0.0.1 (an internal address) stands in for llama.cpp.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { MAX_INTENT_RESPONSE_BYTES } from '../lib/limits.js';
import { OutboundBlocked, outboundFetch } from '../lib/outbound.js';
import { llamaEndpoint, llamaModel, intentModelFromEnv, stubModel } from './model.js';
import { callTurn, contextMessages, type ChatMessage } from './prompt.js';

const KEY = 'sk-intent-secret-key-0123456789';

interface Seen {
  path: string;
  auth: string | undefined;
  body: any;
}
const seen: Seen[] = [];
let mode: 'ok' | 'redirect' | 'huge' | 'hang' | '500' = 'ok';
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
  { role: 'user', content: callTurn({ position: 1, call: { upstream: 'H', tool: 't', description: null, annotations: null, args: {} }, describe: true, earlier: [] }) },
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
    expect(seen[0]!.body).toEqual({
      model: 'qwen',
      messages,
      max_tokens: 300,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
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
    expect(intentModelFromEnv({ INTENT_LLM_URL: 'http://10.0.0.5:8080', INTENT_LLM_MODEL: 'm1' })?.name).toBe('m1');
    expect(intentModelFromEnv({ INTENT_LLM_STUB: '1' })?.name).toBe('stub');
    expect(intentModelFromEnv({ INTENT_LLM_STUB: 'true', INTENT_LLM_URL: '' })).toBeNull();
    quiet.forEach((s) => s.mockRestore());
  });

  test('stub answers by marker', async () => {
    const stub = stubModel();
    const ask = (args: unknown) =>
      stub.complete(
        [...contextMessages([]), { role: 'user', content: callTurn({ position: 1, call: { upstream: 'H', tool: 'del', description: null, annotations: null, args }, describe: false, earlier: [] }) }],
        new AbortController().signal,
      );
    expect(JSON.parse((await ask({})).text)).toEqual({ intent: 'Stub: del', risk: 'write' });
    expect(JSON.parse((await ask({ __stub: 'harmlos' })).text)).toEqual({ intent: 'Stub: del', risk: 'read' });
    expect((await ask({ __stub: 'garbage' })).text).toBe('Das ist kein JSON.');
    await expect(ask({ __stub: 'fail' })).rejects.toThrow();
  });
});
