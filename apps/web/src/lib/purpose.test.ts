// TC-173/TC-174 (unit): what the "Wofür?" field sends, with and without a
// tapped AI suggestion.
import { describe, expect, it } from 'vitest';
import { purposeChips, purposeFields } from './purpose';

describe('purposeFields', () => {
  it('typed text: a purpose for both (no source = typed)', () => {
    expect(purposeFields('allow', '  Putzaufgaben anlegen ', null)).toEqual({ purpose: 'Putzaufgaben anlegen' });
    expect(purposeFields('deny', 'keine Aufgaben archivieren', null)).toEqual({ purpose: 'keine Aufgaben archivieren' });
  });
  it('empty: nothing', () => {
    expect(purposeFields('allow', '   ', 'Aufgaben archivieren')).toEqual({});
    expect(purposeFields('deny', '', null)).toEqual({});
  });
  it('untouched chip text: suggested on a Zeitfreigabe', () => {
    expect(purposeFields('allow', 'Aufgaben archivieren', 'Aufgaben archivieren')).toEqual({ purpose: 'Aufgaben archivieren', purposeSource: 'suggested' });
  });
  it('untouched chip text: NO purpose on a Sperre (S3)', () => {
    expect(purposeFields('deny', 'Aufgaben archivieren', 'Aufgaben archivieren')).toEqual({});
  });
  it('edited after the tap: typed (and a Sperre takes it)', () => {
    expect(purposeFields('allow', 'Aufgaben archivieren, nur erledigte', 'Aufgaben archivieren')).toEqual({ purpose: 'Aufgaben archivieren, nur erledigte' });
    expect(purposeFields('deny', 'Aufgaben archivieren, nur erledigte', 'Aufgaben archivieren')).toEqual({ purpose: 'Aufgaben archivieren, nur erledigte' });
  });
});

describe('purposeChips', () => {
  it('both, one, none', () => {
    expect(purposeChips('Aufgabe 21 archivieren', 'Aufgaben archivieren')).toEqual([
      { key: 'narrow', label: 'Nur dies', text: 'Aufgabe 21 archivieren' },
      { key: 'kind', label: 'Diese Art', text: 'Aufgaben archivieren' },
    ]);
    expect(purposeChips(null, 'Aufgaben archivieren').map((c) => c.key)).toEqual(['kind']);
    expect(purposeChips('  ', undefined)).toEqual([]);
    expect(purposeChips(null, null)).toEqual([]);
  });
});
