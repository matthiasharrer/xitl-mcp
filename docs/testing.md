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

### Upstream registry (ADR-0010, 0013): `e2e/tests/upstreams-api.spec.ts`, `upstreams-ui.spec.ts`

| ID    | Case |
| ----- | ---- |
| TC-05 | `POST /api/upstreams` with name, slug, URL, description, default policy creates an upstream (`status` `NOT_CONNECTED` for OAUTH; `CONNECTED` for HEADER/NONE, which need no connect step, from slice 2 on). Slug must match `^[a-z0-9][a-z0-9-]{0,31}$`, URL must be `http(s)://`, otherwise 400 with a German message. Same slug twice for one user → 409; the same slug for a *different* user is fine. |
| TC-06 | Cross-user: `anna` gets 404 on `GET/PATCH/DELETE /api/upstreams/<matthias's id>`, and her `GET /api/upstreams` doesn't list it. |
| TC-07 | No response from `/api/upstreams*` ever contains `accessToken`, `refreshToken`, `headerValue`, `oauthClient`, `pendingAuth` (checked on list, get, create, update), even when they're set in the DB. |
| TC-08 | ⚡ At 390×844: Einstellungen → Upstream hinzufügen → fill the form → it appears in the list with its status; edit the description; delete it after a confirmation dialog. No horizontal scroll. |

### Inbound MCP OAuth (ADR-0012, 0014): `e2e/tests/mcp-oauth.spec.ts`

| ID    | Case |
| ----- | ---- |
| TC-09 | ⚡ DCR → `/oauth/authorize` as `matthias` (PKCE, CSRF) → `/mcp/token` → `initialize` on `/mcp/<slug of his upstream>` succeeds; `tools/list` answers (empty until the proxy core exists). |
| TC-10 | `/mcp/<slug>` without a token → 401 with `WWW-Authenticate` carrying `resource_metadata`; that URL answers with `resource` = `<origin>/mcp/<slug>`. |
| TC-11 | Matthias's token on `/mcp/<slug>` that only `anna` has → 404; on an unknown slug → 404. Never 200, never another user's server. |
| TC-12 | The raw `MCP_TOKEN` as a bearer → 401. A token for a client revoked in Settings → 401. |
| TC-13 | `/oauth/authorize` without `Remote-User` → 401. The client is bound to the approving user; `anna` approving Matthias's already-bound client → refused. |
| TC-14 | Settings lists only the user's own MCP clients and shows both endpoint URLs per upstream (`/mcp/<slug>`; `/mcp` marked as coming later); revoke asks for confirmation. |

### Fake upstream (test fixture)

`e2e/support/fakeUpstream.ts`, started by Playwright as a second server on
:3210: a minimal OAuth AS (metadata, DCR, PKCE, an authorize endpoint that
auto-approves and redirects, token + refresh with a configurable short TTL, a
switch to reject refreshes) and a Streamable-HTTP MCP server with server
instructions and tools `list_items` (`readOnlyHint`), `add_item`, `delete_all`
(`destructiveHint`), plus a control endpoint to add a tool, read call counts
and the tokens it issued. Never the real Haushalt: e2e stays hermetic.

### Upstream connection (ADR-0013): `e2e/tests/upstream-connect.spec.ts`

| ID    | Case |
| ----- | ---- |
| TC-15 | ⚡ Einstellungen → "Verbinden" on an OAUTH upstream → (fake AS approves) → back on Einstellungen, status "Verbunden". The DB holds tokens; no API response contains them. |
| TC-16 | The OAuth callback is bound to the user who started it: the right `state` presented as `anna` → 400, nothing stored; an unknown or already-used `state` → 400. |
| TC-17 | Expired access token → the next proxied call refreshes transparently and succeeds. Refresh rejected → status "Neu verbinden nötig", the agent gets an `isError` result saying the upstream must be reconnected, the UI offers "Neu verbinden". |
| TC-18 | No upstream token issued by the fake AS appears in any xitl API response, MCP result, MCP error or the API log (`.e2e` server output). |

### Proxy and policy (ADR-0004, 0014): `e2e/tests/proxy.spec.ts`, `apps/api/src/lib/policy.test.ts`

| ID    | Case |
| ----- | ---- |
| TC-19 | ⚡ With an MCP client token: `initialize` on `/mcp/<slug>` returns instructions containing the upstream's own instructions; `tools/list` returns the upstream's tools; `ask` tools carry the approval stamp in their description; `deny` tools are absent. |
| TC-20 | `tools/call` on an `allow` tool is forwarded; the upstream's result comes back unchanged; one audit entry `FORWARDED` with its `decisionPath`. |
| TC-21 | `tools/call` on a `deny` tool (called by name although hidden) → `isError` result with a reason; the upstream's call count unchanged; audit `DENIED`. |
| TC-22 | Until approval exists (slice 6): an `ask` tool is denied with "Freigabe ist noch nicht verfügbar", audit `DENIED`, path `ask:no-channel`. Fail closed. |
| TC-23 | A tool the upstream adds later is `ask` even under default `allow`, and shows as "Neu" in the policy UI; after the user acknowledges it (or sets a policy), the normal rules apply. |
| TC-24 | Unit: precedence is client override > tool policy > unacknowledged tool (= `ask`) > upstream default; every result names its decision path. Snooze is added in slice 6. |
| TC-25 | ⚡ At 390×844: an upstream's "Regeln" view lists its tools with a read/write hint from annotations and a choice Standard / Erlauben / Fragen / Verbieten, plus per-client overrides; changes apply to the next `tools/list`. |
| TC-26 | Policies and tools are user-scoped: `anna` gets 404 on Matthias's upstream's tools/policy routes. |

### Approval, push, snooze (ADR-0004, 0009): `e2e/tests/approval.spec.ts`, `push.spec.ts`, unit tests

e2e sets a short approval timeout (env, e.g. 3 s) instead of 300 s; push goes
to an outbox file (Haushalt's pattern).

| ID    | Case |
| ----- | ---- |
| TC-27 | ⚡ An `ask` call blocks the client; the Start page shows it (client name, upstream, tool, arguments as readable JSON, time left); "Erlauben" → the client gets the upstream's result; audit `FORWARDED`, path `<rule>+approved:page`. |
| TC-28 | "Ablehnen" → `isError` result naming who declined; upstream not called; audit `DENIED`, path `<rule>+denied:page`. |
| TC-29 | No decision within the timeout → `isError` result "nicht innerhalb von 5 Minuten freigegeben … später erneut versuchen"; audit `TIMED_OUT`; deciding afterwards → 409 "nicht mehr offen", nothing forwarded. |
| TC-30 | Approve with snooze ("1 Stunde nicht mehr fragen") → the next call of the same client + tool is forwarded without asking, path `snooze`; another client still asks; after the TTL (Clock) it asks again. A snooze never upgrades `deny` or an unknown tool (unit). |
| TC-31 | Cross-user: `anna` gets 404 deciding Matthias's pending call and never sees it in her list or live stream. |
| TC-32 | On `ask`, a push goes to each of the user's subscriptions (outbox), never to another user's; payload ≤ 4 KB with call id, upstream, tool, short summary and the approve/deny actions; no upstream credential in it. |
| TC-33 | The service worker's approve/deny action sends the same request the page does (`POST /api/approvals/:id`); tapping the notification body opens the approval page for that call. Scripted at the API level with the SW's exact payload; the SW code is reviewed. |
| TC-34 | ⚡ Einstellungen → "Benachrichtigungen aktivieren" subscribes this device; "Test-Push" sends one (outbox) or reports why it can't. |
| TC-35 | ⚡ "Verlauf" lists the user's calls newest first with outcome and decision path; a call's detail shows arguments and the result excerpt; `anna` sees none of Matthias's. |
| TC-36 | A known, acknowledged tool whose description or annotations change is `ask` again ("Geändert") until acknowledged, even under default `allow`. |
| TC-37 | Unit: approval wait and upstream call share one budget of 300 s from receipt; an approved call's upstream timeout is capped to what's left. |

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
| 2 | 2026-10-04 | TC-01…14 (+1 extra: no `MCP_TOKEN` → 404), unit 13 | all passed (implementer and lead, separately) |
| 3 | 2026-10-04 | TC-01…26, unit 38 | all passed (implementer and lead, separately). TC-16 state expiry unit-only (no clock control in e2e). |
