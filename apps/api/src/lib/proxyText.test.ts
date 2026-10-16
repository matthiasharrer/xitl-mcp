// Text shaping of the proxy (TC-19 stamp, TC-18 scrubbing, audit excerpt).
import { describe, expect, test } from 'vitest';
import {
  INSTRUCTIONS_PREFIX,
  MSG,
  RESULT_TEXT_MAX,
  askStamp,
  instructionsFor,
  resultExcerpt,
  scrubSecrets,
  stampedDescription,
  toolHint,
  unifiedInstructions,
  UNIFIED_SECTION_MAX,
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

describe('unifiedInstructions (ADR-0017)', () => {
  test('has the prefix, the naming rule and one section per upstream', () => {
    const text = unifiedInstructions([
      { slug: 'haushalt', name: 'Haushalt', description: 'Aufgaben', instructions: 'Erst suchen.', state: 'ok' },
      { slug: 'rezepte', name: 'Rezepte', description: 'Kochen', instructions: null, state: 'not-connected' },
    ]);
    expect(text.startsWith(INSTRUCTIONS_PREFIX)).toBe(true);
    expect(text).toContain('`<slug>_<tool>`');
    expect(text).toContain('## Haushalt — Tools `haushalt_…`\n\nAufgaben\n\nErst suchen.');
    expect(text).toContain('## Rezepte — Tools `rezepte_…`\n\n(In xitl nicht verbunden');
    expect(text).not.toContain('Kochen'); // not usable: note only
  });

  test('caps each upstream\'s own instructions', () => {
    const text = unifiedInstructions([
      { slug: 'a', name: 'A', description: null, instructions: 'x'.repeat(UNIFIED_SECTION_MAX * 3), state: 'ok' },
    ]);
    expect(text.length).toBeLessThan(UNIFIED_SECTION_MAX + 500);
    expect(text.endsWith('…')).toBe(true);
  });

  test('state lines (ADR-0022): reconnect replaces the body, unreachable sits above it, ok has none', () => {
    const text = unifiedInstructions([
      { slug: 'a', name: 'A', description: 'Da', instructions: 'Ia', state: 'reconnect' },
      { slug: 'b', name: 'B', description: 'Db', instructions: 'Ib', state: 'unreachable' },
      { slug: 'c', name: 'C', description: 'Dc', instructions: 'Ic', state: 'ok' },
    ]);
    expect(text).toContain('## A — Tools `a_…`\n\n(Muss in xitl neu verbunden werden');
    expect(text).not.toContain('Ia');
    expect(text).toMatch(/## B — Tools `b_…`\n\n\(Zurzeit nicht erreichbar[^]*\)\n\nDb\n\nIb/);
    expect(text).toContain('## C — Tools `c_…`\n\nDc\n\nIc');
  });

  test('is just the header without upstreams', () => {
    expect(unifiedInstructions([]).split('\n\n')).toHaveLength(2);
  });
});

describe('MSG.blocked (ADR-0026, TC-123)', () => {
  // 12:15 UTC = 14:15 in Berlin (CEST).
  const until = new Date('2026-10-06T12:15:00Z');
  test('German, names the tool and the until time (Berlin)', () => {
    const t = MSG.blocked('archive_task', null, until);
    expect(t).toContain('„archive_task“');
    expect(t).toContain('bis 06.10., 14:15 Uhr gesperrt');
    expect(t).toContain('2026-10-06T12:15:00.000Z');
  });
  test('whole upstream: names the upstream and the tool', () => {
    const t = MSG.blocked('archive_task', 'Haushalt', until);
    expect(t).toContain('alle Tools von „Haushalt“ (auch „archive_task“)');
    expect(t).toContain('14:15 Uhr');
  });
});

describe('deny reason in MSG (ADR-0036, TC-223/224/225)', () => {
  const until = new Date('2026-10-06T12:15:00Z');
  test('declined without a reason is the unchanged text', () => {
    const t = 'Abgelehnt: Matthias hat den Aufruf von „add_task“ abgelehnt. / Declined: Matthias declined the call to "add_task".';
    expect(MSG.declined('add_task', 'Matthias')).toBe(`[xitl] ${t}`);
    expect(MSG.declined('add_task', 'Matthias', null)).toBe(`[xitl] ${t}`);
    expect(MSG.declined('add_task', 'Matthias', '')).toBe(`[xitl] ${t}`);
  });
  test('declined with a reason: both halves carry it', () => {
    expect(MSG.declined('add_task', 'Matthias', 'Falsches Tool; lieber x')).toBe(
      '[xitl] Abgelehnt: Matthias hat den Aufruf von „add_task“ abgelehnt. Grund: „Falsches Tool; lieber x“ / Declined: Matthias declined the call to "add_task". Reason: "Falsches Tool; lieber x"',
    );
  });
  test('blocked without a reason is unchanged, with one it is appended per half', () => {
    for (const up of [null, 'Haushalt']) {
      const plain = MSG.blocked('archive_task', up, until);
      expect(plain).not.toContain('Grund');
      expect(plain.endsWith('Do not retry before then.')).toBe(true);
      expect(MSG.blocked('archive_task', up, until, null)).toBe(plain);
      const t = MSG.blocked('archive_task', up, until, 'Nicht nochmal versuchen');
      expect(t).toBe(
        plain.replace(' / Denied', ' Grund: „Nicht nochmal versuchen“ / Denied') + ' Reason: "Nicht nochmal versuchen"',
      );
    }
  });
});
