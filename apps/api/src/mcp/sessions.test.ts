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
  requestDiagnostics,
  toolCallsOf,
} from './sessions.js';

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
