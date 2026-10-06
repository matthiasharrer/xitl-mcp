// TC-107 (unit): the answer parser. Anything unexpected is a failure (null).
import { describe, expect, test } from 'vitest';
import { MAX_INTENT_SUMMARY_CHARS } from '../lib/limits.js';
import { parseAnswer, summaryText } from './parse.js';

describe('parseAnswer (TC-107)', () => {
  test('valid JSON', () => {
    expect(parseAnswer('{"intent":"Legt Milch an.","risk":"write"}')).toEqual({ intent: 'Legt Milch an.', risk: 'write', concerns: null });
    expect(parseAnswer('{"intent":"Löscht alles.","risk":"destructive","concerns":"Passt nicht zum Verlauf."}')).toEqual({
      intent: 'Löscht alles.',
      risk: 'destructive',
      concerns: 'Passt nicht zum Verlauf.',
    });
    expect(parseAnswer('{"intent":"x","risk":" Read "}')?.risk).toBe('read');
    expect(parseAnswer('{"intent":"x","risk":"read","concerns":["a","b",3]}')?.concerns).toBe('a; b');
    expect(parseAnswer('{"intent":"x","risk":"read","concerns":{"a":1}}')?.concerns).toBeNull();
  });

  test('intent is capped and flattened', () => {
    const p = parseAnswer(JSON.stringify({ intent: 'a\n\nb ' + 'x'.repeat(5000), risk: 'read' }))!;
    expect(p.intent.length).toBe(MAX_INTENT_SUMMARY_CHARS);
    expect(p.intent.startsWith('a b x')).toBe(true);
    expect(summaryText({ ...p, concerns: 'y'.repeat(100) }).length).toBe(MAX_INTENT_SUMMARY_CHARS);
  });

  test('failures: non-JSON, missing intent, bad risk, empty', () => {
    for (const bad of [
      '',
      '   ',
      'Das ist kein JSON.',
      '{"risk":"read"}',
      '{"intent":"","risk":"read"}',
      '{"intent":42,"risk":"read"}',
      '{"intent":"x"}',
      '{"intent":"x","risk":"harmlos"}',
      '{"intent":"x","risk":"lesend"}',
      '["intent","read"]',
      'null',
      '{"intent":"x","risk":"read"',
    ]) {
      expect(parseAnswer(bad), bad).toBeNull();
    }
  });

  test('prose or a code fence around exactly one object is accepted', () => {
    expect(parseAnswer('```json\n{"intent":"x","risk":"read"}\n```')?.intent).toBe('x');
    expect(parseAnswer('Hier die Antwort: {"intent":"x","risk":"write"} Fertig.')?.risk).toBe('write');
  });

  test('two objects are not a single object', () => {
    expect(parseAnswer('{"intent":"a","risk":"read"} {"intent":"b","risk":"destructive"}')).toBeNull();
  });

  test('HTML in the intent stays text (the UI escapes it)', () => {
    expect(parseAnswer('{"intent":"<img src=x onerror=alert(1)>","risk":"read"}')?.intent).toBe('<img src=x onerror=alert(1)>');
  });
});
