// ADR-0040: a handle is 6 characters (amendment 2026-11-07) and shown whole;
// anything longer an agent passed is cut to 8.
export function shortHandle(handle: string): string {
  return handle.length > 8 ? handle.slice(0, 8) + '…' : handle;
}

/** The small line on approval cards / Verlauf: undefined = upstream keeps no
 * sessions (nothing shown), null = new session, string = the handle asked for. */
export function upstreamSessionText(handle: string | null | undefined): string | null {
  if (handle === undefined) return null;
  return handle === null ? 'Neue Sitzung' : `Sitzung ${shortHandle(handle)}`;
}
