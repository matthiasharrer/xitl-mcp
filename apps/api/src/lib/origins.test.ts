// ADR-0023 / TC-96 (unit): origin normalizer and validator.
import { describe, expect, test } from 'vitest';
import { MAX_ALLOWED_ORIGINS, normalizeOrigin, originListed, parseAllowedOrigins, storedOrigins } from './origins.js';

describe('normalizeOrigin', () => {
  test.each([
    ['https://ui.example', 'https://ui.example'],
    ['HTTPS://UI.Example:443/', 'https://ui.example'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://localhost:80/', 'http://localhost'],
    ['https://ui.example:8443', 'https://ui.example:8443'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    ['http://[0:0:0:0:0:0:0:1]:8080/', 'http://[::1]:8080'],
    ['  https://ui.example  ', 'https://ui.example'],
    ['https://bücher.example', 'https://xn--bcher-kva.example'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeOrigin(input)).toBe(out);
  });

  test.each([
    'https://a.b/x',
    'https://a.b//',
    'https://a.b/?',
    'https://a.b?q=1',
    'https://a.b#f',
    'https://a.b/#',
    'https://user@a.b',
    'https://user:pw@a.b',
    '*',
    'https://*.example',
    'null',
    'ftp://a.b',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ws://a.b',
    'a.b',
    '//a.b',
    'https://',
    'https:///',
    'https://a b',
    'https://a.b\\x',
    'http://a.b:99999',
    '',
    '   ',
    'x'.repeat(400),
  ])('refuses %s', (input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });

  test('non-strings are refused', () => {
    for (const v of [null, undefined, 1, {}, ['https://a.b']]) expect(normalizeOrigin(v)).toBeNull();
  });
});

describe('parseAllowedOrigins', () => {
  test('normalizes, collapses duplicates (order kept), allows []', () => {
    expect(parseAllowedOrigins(['HTTPS://UI.Example:443/', 'http://localhost:8080', 'https://ui.example'])).toEqual({
      ok: true,
      origins: ['https://ui.example', 'http://localhost:8080'],
    });
    expect(parseAllowedOrigins([])).toEqual({ ok: true, origins: [] });
  });

  test('one bad entry refuses the whole list with a German message naming it', () => {
    const r = parseAllowedOrigins(['https://ok.example', 'https://a.b/x']);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('„https://a.b/x“ ist keine gültige Web-Adresse');
  });

  test('more than 10 distinct -> refused; 10 + duplicates -> fine', () => {
    const ten = Array.from({ length: MAX_ALLOWED_ORIGINS }, (_, i) => `https://h${i}.example`);
    expect(parseAllowedOrigins(ten).ok).toBe(true);
    expect(parseAllowedOrigins([...ten, 'https://h0.example/']).ok).toBe(true);
    const r = parseAllowedOrigins([...ten, 'https://h10.example']);
    expect(r).toEqual({ ok: false, error: 'Höchstens 10 Web-Adressen pro Token.' });
  });

  test('not a list -> refused', () => {
    for (const v of ['https://a.b', null, { 0: 'https://a.b' }]) expect(parseAllowedOrigins(v).ok).toBe(false);
  });
});

describe('originListed', () => {
  const stored = JSON.stringify(['https://ui.example', 'http://localhost:8080']);
  test('exact match of the normalized request origin', () => {
    expect(originListed('https://ui.example', stored)).toBe(true);
    expect(originListed('http://localhost:8080', stored)).toBe(true);
    expect(originListed('https://UI.example', stored)).toBe(true);
  });
  test('anything else is not listed (fail closed)', () => {
    for (const o of ['https://ui.example.evil', 'http://ui.example', 'https://ui.example:444', 'http://localhost:8081', 'null', '', null, undefined]) {
      expect(originListed(o, stored), String(o)).toBe(false);
    }
    expect(originListed('https://ui.example', '[]')).toBe(false);
    expect(originListed('https://ui.example', 'not json')).toBe(false);
    expect(originListed('https://ui.example', '{"a":"https://ui.example"}')).toBe(false);
    expect(storedOrigins(null)).toEqual([]);
  });
});
