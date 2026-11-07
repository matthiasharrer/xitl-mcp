// ADR-0040: an upstream session handle is shown by its first 8 characters.
export function shortHandle(handle: string): string {
  return handle.slice(0, 8) + '…';
}

/** The small line on approval cards / Verlauf: undefined = upstream keeps no
 * sessions (nothing shown), null = new session, string = the handle asked for. */
export function upstreamSessionText(handle: string | null | undefined): string | null {
  if (handle === undefined) return null;
  return handle === null ? 'Neue Sitzung' : `Sitzung ${shortHandle(handle)}`;
}
