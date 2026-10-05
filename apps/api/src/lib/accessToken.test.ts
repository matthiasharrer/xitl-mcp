import { describe, expect, it } from 'vitest';
import { generateAccessToken, hashAccessToken, looksLikeAccessToken, tokenDisplayPrefix } from './accessToken.js';

describe('access tokens', () => {
  it('has the xitl_ prefix and 32 random bytes in base64url', () => {
    const t = generateAccessToken();
    expect(t).toMatch(/^xitl_[A-Za-z0-9_-]{43}$/);
  });
  it('is unique per call', () => {
    expect(generateAccessToken()).not.toBe(generateAccessToken());
  });
  it('hashes to a stable 64-char hex sha256 that differs per token', () => {
    const t = generateAccessToken();
    expect(hashAccessToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAccessToken(t)).toBe(hashAccessToken(t));
    expect(hashAccessToken(t)).not.toBe(hashAccessToken(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')));
    // known vector: sha256("abc")
    expect(hashAccessToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('keeps the first 12 chars as display prefix, never the whole token', () => {
    const t = generateAccessToken();
    expect(tokenDisplayPrefix(t)).toBe(t.slice(0, 12));
    expect(tokenDisplayPrefix(t)).toHaveLength(12);
  });
  it('recognises access-token bearers by prefix only', () => {
    expect(looksLikeAccessToken('xitl_abc')).toBe(true);
    expect(looksLikeAccessToken('eyJ.sig')).toBe(false);
    expect(looksLikeAccessToken('XITL_abc')).toBe(false);
    expect(looksLikeAccessToken('')).toBe(false);
  });
});
