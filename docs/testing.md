# Test plan

> Fixed cases with fixed expectations, so "I tested it" means the same thing
> every time. **This process is binding.** Cases are written from what a
> feature *should* do; a script is one way of running a case.
>
> _Last updated: 2026-10-04_

## Running

```bash
npm run e2e                                    # build, boot :3202 on .e2e/e2e.db, run, tear down
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npm run e2e   # if browsers are "missing"
npm run test:unit                              # Vitest, pure logic
```

## The process

Every change passes three gates:

1. **Feature cases.** A feature ships with its cases in this file, scripted
   wherever deterministic, and they pass.
2. **Full suite.** `npm run e2e` and `npm run test:unit` are green before every
   commit that touches code.
3. **Eyes on it.** UI changes get looked at in a real browser on a 390×844
   viewport (`npx playwright-cli`) before desktop.

The case author is the lead. The runner is never the agent that implemented the
feature.

**Security cases fail closed.** For anything in the malicious-client suite, the
expected result is always a deny/401 *and* an audit record. A case that errors
in some other way has not passed.

## Cases

### Scaffold and identity

| ID    | Case | How |
| ----- | ---- | --- |
| TC-01 | `GET /api/health` answers 200 without any `Remote-*` header. | `e2e/tests/identity-api.spec.ts` |
| TC-02 | `GET /api/me` without `Remote-User` → 401; with it → the user. | `e2e/tests/identity-api.spec.ts` |
| TC-03 | `fixedClock` stands still until advanced. | `apps/api/src/lib/clock.test.ts` |
| TC-04 | ⚡ At 390×844 the page loads, greets the user ("Hallo, …"), no horizontal scroll. | `e2e/tests/smoke.spec.ts` |

## Manual gates (to be defined, see roadmap)

Things no script can prove: a real Claude.ai connection through the proxy, the
DCR/consent flow end to end, push delivery to a real phone (lock screen
actions), and real approval latency against the 300 s limit.

## Run log

Append-only. **Failed** = the app is wrong; **blocked** = something outside the
app stopped the case proving anything.

| # | Date | Scope | Result |
| - | ---- | ----- | ------ |
| 1 | 2026-10-04 | TC-01…04 (scaffold) | 4 passed |
