import { defineConfig } from 'vitest/config';

// Unit tests for pure logic (policy engine, clock-driven timeouts). They never
// touch the DB or the network; time comes from the injected Clock or fake timers.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
