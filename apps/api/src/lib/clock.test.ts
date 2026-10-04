import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';

describe('fixedClock', () => {
  it('TC-03 stands still until advanced', () => {
    const clock = fixedClock('2026-10-04T12:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-04T12:00:00.000Z');
    clock.advance(300_000);
    expect(clock.now().toISOString()).toBe('2026-10-04T12:05:00.000Z');
  });
});
