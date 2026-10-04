// Unit tests for the pure signing/claims logic in mcpOAuth.ts — no HTTP, no
// SDK, no DB (copied from haushalts-todos and converted to Vitest). Run with
// `npm run test:unit`. This is the auth-bypass-risk core of the MCP OAuth
// server (ADR-0012): a signed blob that verifies when it shouldn't is a forged
// token, so the negative cases matter more than the happy path. Feeds
// docs/testing.md TC-12.
import { test, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  signBlob,
  verifyBlob,
  issueAuthCode,
  issueAccessToken,
  issueRefreshToken,
  verifyPkceS256,
  timingSafeEqualStr,
  type AccessClaims,
  type CodeClaims,
  type RefreshClaims,
} from './mcpOAuth.js';

const SECRET = 'test-server-secret-01234567890';

test('access token round-trips: valid signature, right type, carries claims', () => {
  const tok = issueAccessToken({ cid: 'client-abc', uid: 7, scope: ['mcp'] }, SECRET);
  const claims = verifyBlob<AccessClaims>(tok, 'access', SECRET);
  expect(claims).toBeTruthy();
  expect(claims!.cid).toBe('client-abc');
  expect(claims!.uid).toBe(7);
  expect(claims!.scope).toEqual(['mcp']);
  expect(claims!.typ).toBe('access');
  expect(claims!.exp > claims!.iat).toBeTruthy();
});

test('a tampered payload fails verification', () => {
  const tok = issueAccessToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET);
  const [payload, sig] = tok.split('.');
  // Flip a byte in the payload but keep the old signature.
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  decoded.scope = ['mcp', 'admin']; // privilege escalation attempt
  const forgedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
  expect(verifyBlob(`${forgedPayload}.${sig}`, 'access', SECRET)).toBe(null);
});

test('a tampered signature fails verification', () => {
  const tok = issueAccessToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET);
  const [payload] = tok.split('.');
  expect(verifyBlob(`${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, 'access', SECRET)).toBe(null);
});

test('a token signed with a different secret fails (secret rotation logs everything out)', () => {
  const tok = issueAccessToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET);
  expect(verifyBlob(tok, 'access', 'a-different-secret')).toBe(null);
});

test('type confusion is rejected: a refresh token cannot verify as an access token', () => {
  const refresh = issueRefreshToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET);
  expect(verifyBlob(refresh, 'access', SECRET)).toBe(null);
  // ...and vice versa.
  const access = issueAccessToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET);
  expect(verifyBlob(access, 'refresh', SECRET)).toBe(null);
  // Each still verifies as its own type.
  expect(verifyBlob<RefreshClaims>(refresh, 'refresh', SECRET)).toBeTruthy();
  expect(verifyBlob<AccessClaims>(access, 'access', SECRET)).toBeTruthy();
});

test('an expired token is rejected; the same token verified earlier is accepted', () => {
  const t0 = 1_000_000_000_000; // fixed epoch-ms
  const tok = issueAccessToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET, t0);
  // Just before expiry: valid. Just after: rejected.
  expect(verifyBlob<AccessClaims>(tok, 'access', SECRET, t0 + 60 * 1000)).toBeTruthy();
  expect(verifyBlob(tok, 'access', SECRET, t0 + (3600 + 1) * 1000)).toBe(null);
});

test('malformed inputs never throw, always return null', () => {
  for (const bad of ['', '.', 'x.', '.y', 'no-dot', 'a.b.c', '!!!.???']) {
    expect(verifyBlob(bad, 'access', SECRET)).toBe(null);
  }
});

test('auth code carries the PKCE challenge and the exact redirect_uri', () => {
  const code = issueAuthCode(
    { cid: 'c', uid: 1, redirect_uri: 'https://claude.ai/cb', code_challenge: 'CHALLENGE', scope: ['mcp'] },
    SECRET,
  );
  const claims = verifyBlob<CodeClaims>(code, 'code', SECRET);
  expect(claims).toBeTruthy();
  expect(claims!.redirect_uri).toBe('https://claude.ai/cb');
  expect(claims!.code_challenge).toBe('CHALLENGE');
});

test('PKCE S256: the matching verifier passes, a wrong one fails', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  expect(verifyPkceS256(verifier, challenge)).toBe(true);
  expect(verifyPkceS256('the-wrong-verifier', challenge)).toBe(false);
  expect(verifyPkceS256('', challenge)).toBe(false);
});

test('timingSafeEqualStr: equal strings true, any difference false, no throw on length mismatch', () => {
  expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
  expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
  expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  expect(timingSafeEqualStr('', '')).toBe(true);
});

test('signBlob is deterministic for the same claims and secret', () => {
  const claims = { typ: 'access' as const, iat: 1000, exp: 4600, cid: 'c', uid: 1, scope: ['mcp'] };
  expect(signBlob(claims, SECRET)).toBe(signBlob(claims, SECRET));
});

test('the user id is part of the signed payload: forging uid invalidates the signature', () => {
  for (const [typ, tok] of [
    ['access', issueAccessToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET)],
    ['refresh', issueRefreshToken({ cid: 'c', uid: 1, scope: ['mcp'] }, SECRET)],
    ['code', issueAuthCode({ cid: 'c', uid: 1, redirect_uri: 'https://x/cb', code_challenge: 'C', scope: ['mcp'] }, SECRET)],
  ] as const) {
    const [payload, sig] = tok.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(decoded.uid).toBe(1);
    decoded.uid = 2; // act as the other user
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(verifyBlob(`${forged}.${sig}`, typ, SECRET)).toBe(null);
  }
});
