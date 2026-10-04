// Text shaping of the proxy (TC-19 stamp, TC-18 scrubbing, audit excerpt).
import { describe, expect, test } from 'vitest';
import {
  INSTRUCTIONS_PREFIX,
  RESULT_TEXT_MAX,
  askStamp,
  instructionsFor,
  resultExcerpt,
  scrubSecrets,
  stampedDescription,
  toolHint,
} from './proxyText.js';

test('instructions: prefix line, then the upstream own text, else the fallback', () => {
  expect(instructionsFor('Do X.', 'Desc')).toBe(`${INSTRUCTIONS_PREFIX}\n\nDo X.`);
  expect(instructionsFor(null, 'Desc')).toBe(`${INSTRUCTIONS_PREFIX}\n\nDesc`);
  expect(instructionsFor('  ', 'Desc')).toBe(`${INSTRUCTIONS_PREFIX}\n\nDesc`);
});

test('ask stamp names the reviewer in German and English', () => {
  const s = stampedDescription('Adds an item.', 'Matthias');
  expect(s.startsWith('Adds an item.\n\n[xitl] Erfordert Freigabe durch Matthias')).toBe(true);
  expect(s).toContain('Requires approval by Matthias; may take up to 5 minutes.');
  expect(stampedDescription(undefined, 'M')).toBe(askStamp('M'));
});

describe('toolHint', () => {
  test('readOnly wins, explicit destructive, else write', () => {
    expect(toolHint({ readOnlyHint: true, destructiveHint: true })).toBe('read');
    expect(toolHint({ destructiveHint: true })).toBe('destructive');
    expect(toolHint({ readOnlyHint: false })).toBe('write');
    expect(toolHint(null)).toBe('write');
    expect(toolHint('junk')).toBe('write');
  });
});

describe('resultExcerpt', () => {
  test('joins text blocks', () => {
    expect(resultExcerpt({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
  });
  test('falls back to JSON and truncates to the limit', () => {
    expect(resultExcerpt({ content: [], structuredContent: { n: 1 } })).toBe('{"content":[],"structuredContent":{"n":1}}');
    const long = resultExcerpt({ content: [{ type: 'text', text: 'x'.repeat(5000) }] });
    expect(long.length).toBe(RESULT_TEXT_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('scrubSecrets', () => {
  const token = 'fat_secret_token_123456';
  test('replaces a credential anywhere in the result', () => {
    const out = scrubSecrets({ content: [{ type: 'text', text: `your token is ${token}!` }], meta: { t: token } }, [token]);
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.content[0]!.text).toBe('your token is [xitl: entfernt]!');
  });
  test('returns the same object when nothing matches; short or empty secrets are ignored', () => {
    const r = { content: [{ type: 'text', text: 'hello abc' }] };
    expect(scrubSecrets(r, [token])).toBe(r);
    expect(scrubSecrets(r, ['abc', '', null, undefined])).toBe(r);
  });
  test('secrets with JSON-special characters are still found', () => {
    const s = 'tok"en\\with-quotes';
    const out = scrubSecrets({ text: `x ${s} y` }, [s]);
    expect(out.text).toBe('x [xitl: entfernt] y');
  });
});
