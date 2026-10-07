// TC-178…180 (unit): wording of "Läuft gerade" and the shared pause labels.
import { describe, expect, it } from 'vitest';
import { durationText, endAllMessage, isMidnight, pauseWhat, remainingText, runningSummary, scopeText, sinceText } from './pauses';

const now = new Date(2026, 9, 7, 14, 0, 0); // local 07.10.2026 14:00
const plus = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();

describe('summary line (TC-178)', () => {
  it('singular / plural, zero parts left out, next end', () => {
    expect(runningSummary(1, 0, 0, plus(12), now)).toBe('Läuft gerade: 1 Zeitfreigabe · nächstes Ende in 12 Min.');
    expect(runningSummary(2, 1, 1, plus(65), now)).toBe('Läuft gerade: 2 Zeitfreigaben · 1 Sperre · 1 Zugang pausiert · nächstes Ende in 1 Std. 5 Min.');
    expect(runningSummary(0, 3, 2, plus(60), now)).toBe('Läuft gerade: 3 Sperren · 2 Zugänge pausiert · nächstes Ende in 1 Std.');
    expect(runningSummary(0, 0, 1, null, now)).toBe('Läuft gerade: 1 Zugang pausiert');
    expect(runningSummary(0, 0, 0, null, now)).toBeNull();
  });
});

describe('row texts (TC-179)', () => {
  it('what', () => {
    expect(pauseWhat({ scope: 'TOOL', toolName: 'add_task' }, 'Haushalt')).toBe('add_task');
    expect(pauseWhat({ scope: 'READONLY', toolName: null }, 'Haushalt')).toBe('alle Lesetools von Haushalt');
    expect(pauseWhat({ scope: 'UPSTREAM', toolName: null }, 'Haushalt')).toBe('ganz Haushalt');
    expect(scopeText({ scope: 'UPSTREAM' })).toBe('alle Tools');
    expect(scopeText({ scope: 'TOOL' })).toBeNull();
  });
  it('remaining at minute granularity; "bis Mitternacht"', () => {
    expect(durationText(30_000)).toBe('< 1 Min.');
    expect(durationText(11 * 60_000 + 1)).toBe('12 Min.');
    expect(remainingText(plus(12), now)).toBe('noch 12 Min.');
    // Midnight in Europe/Berlin (CEST) whatever the browser's zone.
    const midnight = new Date('2026-10-07T22:00:00Z');
    const noon = new Date('2026-10-07T10:00:00Z');
    expect(isMidnight(midnight, noon)).toBe(true);
    expect(isMidnight(new Date('2026-10-07T23:00:00Z'), noon)).toBe(false);
    expect(remainingText(midnight.toISOString(), noon)).toBe('bis Mitternacht');
    // The last hour before midnight counts down instead.
    expect(remainingText(midnight.toISOString(), new Date('2026-10-07T21:30:00Z'))).toBe('noch 30 Min.');
  });
  it('since', () => {
    expect(sinceText(new Date(2026, 9, 7, 9, 5).toISOString(), now)).toBe('seit 09:05');
    expect(sinceText(new Date(2026, 9, 6, 9, 5).toISOString(), now)).toMatch(/^seit 06\.10\., 09:05$/);
  });
});

describe('"Alle beenden" dialog (TC-180)', () => {
  it('counts; paused accesses stay', () => {
    expect(endAllMessage(2, 1, 0)).toBe('2 Zeitfreigaben beenden und 1 Sperre aufheben?');
    expect(endAllMessage(1, 0, 2)).toBe('1 Zeitfreigabe beenden? Pausierte Zugänge bleiben pausiert – die setzt du einzeln mit „Fortsetzen“ fort.');
  });
});
