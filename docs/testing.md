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
| TC-05 | `POST /api/upstreams` with name, slug, URL, description, default policy creates an upstream (`status` `NOT_CONNECTED`). Slug must match `^[a-z0-9][a-z0-9-]{0,31}$`, URL must be `http(s)://`, otherwise 400 with a German message. Same slug twice for one user → 409; the same slug for a *different* user is fine. |
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
