// xitl as its own upstream (lib/selfLoop.ts), unit half: TC-130.
import { describe, expect, test } from 'vitest';
import { isOwnOrigin, isOwnRequest, ownInstanceId } from './selfLoop.js';

describe('isOwnOrigin', () => {
  const own = 'https://xitl.example';
  test.each([
    ['https://xitl.example/mcp/rezepte', true],
    ['https://XITL.example:443/mcp', true],
    ['https://xitl.example', true],
    ['https://xitl.example:8443/mcp', false],
    ['http://xitl.example/mcp', false],
    ['https://rezepte.example/mcp', false],
    ['https://xitl.example.evil/mcp', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isOwnOrigin(url, own)).toBe(expected);
  });

  test('local dev origin with port', () => {
    expect(isOwnOrigin('http://127.0.0.1:3002/mcp/x', 'http://127.0.0.1:3002')).toBe(true);
    expect(isOwnOrigin('http://localhost:3002/mcp/x', 'http://127.0.0.1:3002')).toBe(false);
  });
});

describe('isOwnRequest', () => {
  test('only our own id counts', () => {
    expect(isOwnRequest(ownInstanceId())).toBe(true);
    expect(isOwnRequest(` ${ownInstanceId()} `)).toBe(true);
    expect(isOwnRequest(undefined)).toBe(false);
    expect(isOwnRequest('')).toBe(false);
    expect(isOwnRequest('0'.repeat(32))).toBe(false);
  });

  test('the id is random hex, 32 chars', () => {
    expect(ownInstanceId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
