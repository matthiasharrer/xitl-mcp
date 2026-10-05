import { describe, expect, it } from 'vitest';
import {
  MAX_HEADER_NAMES,
  clientInfoOf,
  echoableId,
  headerNamesOf,
  isSessionId,
  legacyInitializeOf,
  mergeNames,
  messagesOf,
  newSessionId,
  parseNames,
  cloudTraceIdOf,
  requestDiagnostics,
  sessionsToPrune,
  traceIdOf,
  toolCallsOf,
} from './sessions.js';
import { MAX_SESSIONS_PER_USER, SESSION_TTL_MS } from '../lib/limits.js';

describe('session ids', () => {
  it('are 256-bit base64url, distinct, and recognised', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isSessionId(a)).toBe(true);
  });
  it('rejects anything else without a lookup', () => {
    for (const bad of ['', 'x', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)} `, null, undefined]) {
      expect(isSessionId(bad as string)).toBe(false);
    }
  });
});

describe('legacyInitializeOf', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  it('finds a 2025-era initialize', () => {
    expect(legacyInitializeOf(messagesOf(init))).toBe(init);
  });
  it('ignores an initialize carrying a 2026 envelope and other methods', () => {
    const modern = { ...init, params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } };
    expect(legacyInitializeOf(messagesOf(modern))).toBeNull();
    expect(legacyInitializeOf(messagesOf({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toBeNull();
    expect(legacyInitializeOf(messagesOf('nonsense'))).toBeNull();
  });
});

describe('clientInfoOf', () => {
  it('reads and clips clientInfo and protocolVersion', () => {
    const info = clientInfoOf({ params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '0.1.0' } } });
    expect(info).toEqual({ clientName: 'claude-ai', clientVersion: '0.1.0', protocolVersion: '2025-06-18' });
    const long = clientInfoOf({ params: { clientInfo: { name: 'x'.repeat(1000), version: 5 } } });
    expect(long.clientName).toHaveLength(200);
    expect(long.clientVersion).toBeNull();
    expect(clientInfoOf({}).clientName).toBeNull();
  });
});

describe('toolCallsOf', () => {
  it('counts tools/call and collects _meta keys (not values)', () => {
    const msgs = messagesOf([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a', _meta: { progressToken: 1, 'claudeai/chat': 'secret' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'b' } },
    ]);
    expect(toolCallsOf(msgs)).toEqual({ calls: 2, metaKeys: ['progressToken', 'claudeai/chat'] });
  });
});

describe('header names', () => {
  it('are names only, lower-cased', () => {
    const h = new Headers({ Authorization: 'Bearer secret', 'User-Agent': 'x', 'X-Custom': 'v' });
    const names = headerNamesOf(h);
    expect(names.sort()).toEqual(['authorization', 'user-agent', 'x-custom']);
    expect(JSON.stringify(names)).not.toContain('secret');
  });
  it('merge into a sorted, capped union', () => {
    expect(mergeNames('["b"]', ['a', 'b', 'c'], 10, 100)).toEqual(['a', 'b', 'c']);
    expect(mergeNames('not json', ['a'], 10, 100)).toEqual(['a']);
    expect(mergeNames('[]', ['x'.repeat(101), 'ok'], 10, 100)).toEqual(['ok']);
    const many = Array.from({ length: 500 }, (_, i) => `h${i}`);
    expect(mergeNames('[]', many, MAX_HEADER_NAMES, 100)).toHaveLength(MAX_HEADER_NAMES);
  });
  it('parseNames tolerates junk', () => {
    expect(parseNames('[1,"a",null]')).toEqual(['a']);
    expect(parseNames('{}')).toEqual([]);
  });
});

describe('echoableId', () => {
  it('echoes a single request id only', () => {
    expect(echoableId(messagesOf({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), false)).toBe(7);
    expect(echoableId(messagesOf([{ jsonrpc: '2.0', id: 7, method: 'tools/list' }]), true)).toBeNull();
    expect(echoableId([], false)).toBeNull();
  });
});

describe('requestDiagnostics', () => {
  it('2026-era call: version and clientInfo from _meta, names only', () => {
    const headers = new Headers({ 'User-Agent': 'Claude-User', Authorization: 'Bearer secret', 'X-Trace': 'v' });
    const d = requestDiagnostics(headers, [
      {
        method: 'tools/call',
        params: {
          name: 'x',
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '1' },
            'claude/conversationId': 'abc',
          },
        },
      },
    ]);
    expect(d).toMatchObject({ protocolVersion: '2026-07-28', clientName: 'claude-ai', clientVersion: '1', userAgent: 'Claude-User' });
    expect(d.headerNames).toEqual(['authorization', 'user-agent', 'x-trace']);
    expect(JSON.stringify(d)).not.toContain('secret');
    expect(d.metaKeys).toContain('claude/conversationId');
    expect(JSON.stringify(d)).not.toContain('abc');
  });

  it('2025-era: version from the header, nothing else required', () => {
    const d = requestDiagnostics(new Headers({ 'MCP-Protocol-Version': '2025-06-18' }), [{ method: 'tools/call', params: { name: 'x' } }]);
    expect(d).toMatchObject({ protocolVersion: '2025-06-18', clientName: null, userAgent: null, metaKeys: [] });
  });
});

describe('trace correlation (grouping candidates)', () => {
  it('takes only the trace part', () => {
    expect(traceIdOf('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(traceIdOf('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(traceIdOf('garbage')).toBeNull();
    expect(traceIdOf(null)).toBeNull();
    expect(cloudTraceIdOf('105445aa7843bc8bf206b12000100000/1;o=1')).toBe('105445aa7843bc8bf206b12000100000');
    expect(cloudTraceIdOf('105445aa7843bc8bf206b12000100000')).toBe('105445aa7843bc8bf206b12000100000');
    expect(cloudTraceIdOf('x/1')).toBeNull();
  });

  it('records the x-anthropic-client value only when it is a short token', () => {
    const d = (v: string) => requestDiagnostics(new Headers({ 'x-anthropic-client': v }), []).anthropicClient;
    expect(d('claude-ai/1.0')).toBe('claude-ai/1.0');
    expect(d('has space')).toBeNull();
  });
});

// TC-100 (unit): which sessions expire. The DB half (the scoped delete, audit
// rows keeping their call with sessionId null) is covered by e2e TC-100.
describe('sessionsToPrune (TC-100)', () => {
  const now = new Date(Date.UTC(2026, 9, 5, 12, 0));
  const DAY = 24 * 60 * 60 * 1000;
  const row = (id: string, ageMs: number, userId = 1) => ({ id, userId, lastSeenAt: new Date(now.getTime() - ageMs) });

  it('limits: 30 days, 500 per user', () => {
    expect(SESSION_TTL_MS).toBe(30 * DAY);
    expect(MAX_SESSIONS_PER_USER).toBe(500);
  });

  it('older than 30 days goes, exactly 30 days stays, younger stays', () => {
    const rows = [row('a', 31 * DAY), row('b', DAY), row('c', 30 * DAY), row('d', 30 * DAY + 1)];
    expect(sessionsToPrune(rows, now).sort()).toEqual(['a', 'd']);
  });

  it('over the cap the least recently seen go first (ties by id)', () => {
    const rows = [row('k', 3 * DAY), row('m', DAY), row('z', 5 * DAY), row('y', 5 * DAY), row('n', 2 * DAY)];
    expect(sessionsToPrune(rows, now, { maxPerUser: 3 })).toEqual(['y', 'z']);
  });

  it('reserve leaves room for the session about to be created', () => {
    const rows = [row('a', 3 * DAY), row('b', 2 * DAY), row('c', DAY)];
    expect(sessionsToPrune(rows, now, { maxPerUser: 3 })).toEqual([]);
    expect(sessionsToPrune(rows, now, { maxPerUser: 3, reserve: 1 })).toEqual(['a']);
  });

  it('expired ones go first, then the cap applies to the rest', () => {
    const rows = [row('a', 40 * DAY), row('b', 3 * DAY), row('c', 2 * DAY), row('d', DAY)];
    expect(sessionsToPrune(rows, now, { maxPerUser: 2, reserve: 1 })).toEqual(['a', 'b', 'c']);
  });

  it('each user is counted on their own; other users never push anyone out', () => {
    const rows = [
      row('u1-old', 3 * DAY, 1),
      row('u1-new', DAY, 1),
      row('u2-a', 9 * DAY, 2),
      row('u2-b', 8 * DAY, 2),
      row('u2-c', 7 * DAY, 2),
      row('u3', 60 * DAY, 3),
    ];
    // user 1 is under the cap of 2 even though 5 live sessions exist overall
    expect(sessionsToPrune(rows, now, { maxPerUser: 2 }).sort()).toEqual(['u2-a', 'u3']);
    // only user 1's rows given (the per-user call before a create): only theirs can go
    expect(sessionsToPrune(rows.filter((r) => r.userId === 1), now, { maxPerUser: 2, reserve: 1 })).toEqual(['u1-old']);
  });

  it('a custom maxAgeMs is honoured; nothing to do is an empty list', () => {
    expect(sessionsToPrune([row('a', 2 * DAY)], now, { maxAgeMs: DAY })).toEqual(['a']);
    expect(sessionsToPrune([], now, { reserve: 1 })).toEqual([]);
  });
});
