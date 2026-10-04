# 0003. Clock, LLM endpoint and push sender are injectable from the start

- **Status:** Accepted (2026-10-04)
- **Date:** 2026-10-04

## Context

Most of the work here will be done and verified by autonomous agents. The
interesting behaviour is time-driven (300 s auto-deny, snooze TTLs), calls an
LLM (intent summary, reviewer agent) or reaches a phone (Web Push). None of
those can be tested deterministically if code reaches for `Date.now()`, a real
model or a real push service.

## Decision

- **Clock:** every time read goes through `Clock` (`apps/api/src/lib/clock.ts`).
  Unit tests use `fixedClock` or Vitest fake timers.
- **LLM endpoint:** intent summary and reviewer are called through an interface
  whose test implementation is a **local deterministic stub** (fixed answers
  keyed by input), selectable by env in e2e.
- **Push sender:** an interface; in e2e it appends to an outbox file instead of
  sending (the pattern Haushalt's `PUSH_OUTBOX` uses).
- Test layers: Vitest (pure logic, fake timers), Playwright (UI + HTTP), an
  **MCP test client** (drives the proxy like Claude would), and a
  **"malicious client" suite** (prompt-injection attempts, forged arguments,
  token misuse) that must fail closed.

## Consequences

- Wiring cost on every feature: dependencies are passed in, not imported.
- Real-world behaviour (Claude.ai's actual 300 s limit, real push latency, real
  DCR) still needs manual gates; see `testing.md`.

## Alternatives considered

- **Mock at module level per test.** Brittle, and lets `Date.now()` creep back in.
