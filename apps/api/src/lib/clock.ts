// Injectable time (ADR-0003). Approval timeouts, snooze TTLs and audit
// timestamps all read time through a Clock, never Date.now() directly, so
// tests (and autonomous agents running them) can drive time deterministically.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to. For tests. */
export function fixedClock(start: Date | string): Clock & { advance(ms: number): void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}
