// Live rows in Verlauf (ADR-0028). Pure, unit-tested in historyLive.test.ts.
// The list is newest first by id and paginated (`nextBefore`): the loaded
// entries are the newest ones down to some id, older ones are fetched on
// demand. A live row may only go in where it belongs in that window.
import type { AuditRow } from './api';

const byIdDesc = (a: AuditRow, b: AuditRow) => b.id - a.id;

/** A row that was created or changed on the server. Known id: replaced in
 * place. New id: inserted when it lies inside the loaded window (newer than
 * the oldest loaded row, or everything is loaded); a row older than the
 * window stays out, "Ältere laden" brings it. Returns the same array when
 * nothing changed. */
export function applyLiveRow(entries: AuditRow[], nextBefore: number | null, row: AuditRow): AuditRow[] {
  const at = entries.findIndex((e) => e.id === row.id);
  if (at >= 0) {
    const next = entries.slice();
    next[at] = row;
    return next;
  }
  const oldest = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  const inWindow = nextBefore === null || (oldest !== null && row.id > oldest);
  if (!inWindow) return entries;
  return [...entries, row].sort(byIdDesc);
}

/** After a reconnect: the freshly fetched first page replaces the newest part
 * of the list; older pages the user already loaded are kept (rows from the
 * page are authoritative where ids overlap). */
export function mergeFirstPage(entries: AuditRow[], page: AuditRow[], pageNextBefore: number | null): AuditRow[] {
  if (pageNextBefore === null || page.length === 0) return page;
  const floor = page[page.length - 1]!.id;
  const older = entries.filter((e) => e.id < floor);
  return [...page, ...older].sort(byIdDesc);
}
