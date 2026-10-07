// Shared wording for Zeitfreigaben / Sperren / paused accesses (Rules'
// "Aktive Zeitfreigaben und Sperren" and the "Läuft gerade" overview,
// TC-178…183). Pure, unit tested (pauses.test.ts). Times in the browser's
// zone (Matthias: Europe/Berlin).

export type PauseScope = 'TOOL' | 'READONLY' | 'UPSTREAM';
export interface PauseLike {
  effect: 'ALLOW' | 'DENY';
  scope: PauseScope;
  toolName: string | null;
}

const timeOnly = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** Rules (inside one upstream): "alle Tools" / "alle Lesetools", or null = the tool's name. */
export const scopeText = (p: Pick<PauseLike, 'scope'>) => (p.scope === 'UPSTREAM' ? 'alle Tools' : p.scope === 'READONLY' ? 'alle Lesetools' : null);

/** Across upstreams: the tool name, "alle Lesetools von X" or "ganz X". */
export function pauseWhat(p: Pick<PauseLike, 'scope' | 'toolName'>, upstreamName: string): string {
  if (p.scope === 'UPSTREAM') return `ganz ${upstreamName}`;
  if (p.scope === 'READONLY') return `alle Lesetools von ${upstreamName}`;
  return p.toolName ?? '?';
}

export const kindText = (p: Pick<PauseLike, 'effect'>) => (p.effect === 'ALLOW' ? 'Zeitfreigabe' : 'Sperre');

/** "bis 14:30 Uhr" (today) or "bis 08.10., 14:30 Uhr". */
export function untilText(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return `bis ${sameDay(d, now) ? timeOnly.format(d) : dayTime.format(d)} Uhr`;
}

/** A duration at minute granularity: "< 1 Min.", "12 Min.", "1 Std. 5 Min.", "3 Std.". */
export function durationText(ms: number): string {
  if (ms < 60_000) return '< 1 Min.';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} Min.`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} Std.` : `${h} Std. ${m} Min.`;
}

/** Wall-clock hh:mm in Europe/Berlin: the server's "bis Mitternacht" means
 * midnight there (approval/budget.ts), whatever zone the browser is in. */
const berlinHm = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A "bis Mitternacht" pause ends at 00:00 Berlin time within the next 24 h. */
export function isMidnight(until: Date, now: Date): boolean {
  const ms = until.getTime() - now.getTime();
  return ms > 0 && ms <= 24 * 3600_000 && berlinHm.format(until) === '00:00';
}

/** "noch 12 Min." or "bis Mitternacht". */
export function remainingText(iso: string, now: Date): string {
  const until = new Date(iso);
  if (isMidnight(until, now) && until.getTime() - now.getTime() > 60 * 60_000) return 'bis Mitternacht';
  return `noch ${durationText(until.getTime() - now.getTime())}`;
}

/** "seit 14:03" (today) or "seit 06.10., 14:03". */
export function sinceText(iso: string, now: Date): string {
  const d = new Date(iso);
  return `seit ${sameDay(d, now) ? timeOnly.format(d) : dayTime.format(d)}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The collapsed line (TC-178): zero parts left out; null = nothing active. */
export function runningSummary(allows: number, denies: number, paused: number, nextEnd: string | null, now: Date): string | null {
  const parts: string[] = [];
  if (allows > 0) parts.push(plural(allows, 'Zeitfreigabe', 'Zeitfreigaben'));
  if (denies > 0) parts.push(plural(denies, 'Sperre', 'Sperren'));
  if (paused > 0) parts.push(`${plural(paused, 'Zugang', 'Zugänge')} pausiert`);
  if (parts.length === 0) return null;
  if (nextEnd) parts.push(`nächstes Ende in ${durationText(new Date(nextEnd).getTime() - now.getTime())}`);
  return `Läuft gerade: ${parts.join(' · ')}`;
}

/** Text of the "Alle beenden" confirmation (TC-180). */
export function endAllMessage(allows: number, denies: number, paused: number): string {
  const what: string[] = [];
  if (allows > 0) what.push(`${plural(allows, 'Zeitfreigabe', 'Zeitfreigaben')} beenden`);
  if (denies > 0) what.push(`${plural(denies, 'Sperre', 'Sperren')} aufheben`);
  const head = `${what.join(' und ')}?`;
  return paused > 0
    ? `${head} Pausierte Zugänge bleiben pausiert – die setzt du einzeln mit „Fortsetzen“ fort.`
    : head;
}
