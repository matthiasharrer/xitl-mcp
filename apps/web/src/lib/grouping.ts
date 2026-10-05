// Grouping of calls in Verlauf and Freigaben (ADR-0016, decided after the
// MG-06 measurement: Claude.ai and Claude Code send nothing stable per chat).
// Pure functions, unit-tested in grouping.test.ts.
//
// - Days: calendar days in the browser's time zone, labelled "Heute",
//   "Gestern", else e.g. "Mo., 3. Okt." (with the year when it isn't this year).
// - Groups inside a day: calls of the same MCP session when the client has one
//   (2025-era clients), else of the same client with no gap longer than
//   GROUP_GAP_MS between consecutive calls. Calls of two clients that overlap
//   in time form two groups, ordered by their newest call.

/** A gap longer than this between two calls of one client starts a new group. */
export const GROUP_GAP_MS = 10 * 60 * 1000;

export interface Groupable {
  receivedAt: string;
  clientId: number | null;
  clientName: string | null;
  session: { id: string; createdAt: string } | null;
}

export interface CallGroup<T extends Groupable> {
  key: string;
  clientName: string | null;
  session: T['session'];
  /** Newest first, like the input. */
  items: T[];
  /** Oldest and newest call of the group. */
  from: Date;
  to: Date;
}

export interface CallDay<T extends Groupable> {
  key: string;
  label: string;
  groups: CallGroup<T>[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "Heute", "Gestern", or the date (weekday, day, month; year if not `now`'s). */
export function dayLabel(d: Date, now: Date): string {
  if (dayKey(d) === dayKey(now)) return 'Heute';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return 'Gestern';
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  }).format(d);
}

/** What makes two calls belong together: the session, else the client. */
function sourceKey(item: Groupable): string {
  if (item.session) return `s:${item.session.id}`;
  return item.clientId !== null ? `c:${item.clientId}` : `n:${item.clientName ?? ''}`;
}

/** Newest first by `receivedAt` (the API orders by id, which is the same in
 * practice; sorted here so the grouping never depends on it). Stable. */
function newestFirst<T extends Groupable>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i, t: new Date(item.receivedAt).getTime() }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.item);
}

/** Groups calls; the result and each group's items are newest first. */
export function groupCalls<T extends Groupable>(items: T[], gapMs = GROUP_GAP_MS): CallGroup<T>[] {
  const groups: CallGroup<T>[] = [];
  /** The currently open group per source (the one its next older call may join). */
  const open = new Map<string, CallGroup<T>>();
  for (const item of newestFirst(items)) {
    const at = new Date(item.receivedAt);
    const source = sourceKey(item);
    const current = open.get(source);
    // Sessions are one group however long the pauses; clients split on gaps.
    if (current && (item.session !== null || current.from.getTime() - at.getTime() <= gapMs)) {
      current.items.push(item);
      if (at < current.from) current.from = at;
      continue;
    }
    const group: CallGroup<T> = {
      key: `${source}@${item.receivedAt}`,
      clientName: item.clientName,
      session: item.session,
      items: [item],
      from: at,
      to: at,
    };
    groups.push(group);
    open.set(source, group);
  }
  return groups;
}

/** Day separators, then groups per day. A group never spans two days. */
export function groupByDay<T extends Groupable>(items: T[], now: Date, gapMs = GROUP_GAP_MS): CallDay<T>[] {
  const days: CallDay<T>[] = [];
  let currentKey: string | null = null;
  let bucket: T[] = [];
  const flush = () => {
    if (currentKey === null || bucket.length === 0) return;
    days.push({ key: currentKey, label: dayLabel(new Date(bucket[0]!.receivedAt), now), groups: groupCalls(bucket, gapMs) });
  };
  for (const item of newestFirst(items)) {
    const key = dayKey(new Date(item.receivedAt));
    if (key !== currentKey) {
      flush();
      currentKey = key;
      bucket = [];
    }
    bucket.push(item);
  }
  flush();
  return days;
}
