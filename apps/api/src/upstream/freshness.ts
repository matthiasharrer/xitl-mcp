// Tool freshness on call (ADR-0034): before a tools/call is decided, an
// upstream whose tool list was last synced more than TOOLS_FRESH_MS ago (or
// never) is listed and synced first, so a definition change behind a cached
// client list is caught (changed-tool / new-tool / unknown-tool) instead of
// being decided on the old, acknowledged definition. Pure helpers plus the
// single-flight map; mcp/server.ts does the call-path work (and fails closed
// when the re-list fails: audit DENIED `stale-tools`, never forwarded).

/** ADR-0034: 5 minutes (Matthias, 2026-10-07: "5 min reichen"). */
export const DEFAULT_TOOLS_FRESH_MS = 5 * 60 * 1000;

/** TOOLS_FRESH_MS from the environment (e2e sets a few seconds); anything
 * but a positive integer of milliseconds is the default. */
export function toolsFreshFromEnv(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return DEFAULT_TOOLS_FRESH_MS;
  const n = Number(raw.trim());
  return n > 0 ? n : DEFAULT_TOOLS_FRESH_MS;
}

/** The list must be re-checked: never synced, an unreadable time, a time in
 * the future (clock skew) or older than the window. Fails towards re-listing. */
export function toolsStale(syncedAt: Date | null | undefined, now: Date, windowMs: number): boolean {
  if (!(syncedAt instanceof Date) || Number.isNaN(syncedAt.getTime()) || Number.isNaN(now.getTime())) return true;
  const age = now.getTime() - syncedAt.getTime();
  return age < 0 || age >= windowMs;
}

/** A KnownTool row that the upstream's latest successful list did not contain
 * (`lastSeenAt` older than `toolsSyncedAt`; syncKnownTools stamps both with
 * the same time): the tool vanished, a call to it is `unknown-tool`. Without
 * a sync time nothing can be said (the call path re-lists first anyway). */
export function vanished(lastSeenAt: Date, toolsSyncedAt: Date | null | undefined): boolean {
  if (!(toolsSyncedAt instanceof Date)) return false;
  return lastSeenAt.getTime() < toolsSyncedAt.getTime();
}

/** Concurrent callers of the same key share one in-flight promise (one
 * tools/list per upstream, however many calls arrive at once). The entry is
 * dropped when it settles, success or failure, so the next stale call tries
 * again. */
export class SingleFlight<K, T> {
  private inFlight = new Map<K, Promise<T>>();

  run(key: K, fn: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key);
    if (running) return running;
    // Started on the next microtask, so the entry is in the map before `fn`
    // runs (even one that throws synchronously), and removed only by itself.
    const p: Promise<T> = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.inFlight.get(key) === p) this.inFlight.delete(key);
      });
    this.inFlight.set(key, p);
    return p;
  }

  get size(): number {
    return this.inFlight.size;
  }
}
