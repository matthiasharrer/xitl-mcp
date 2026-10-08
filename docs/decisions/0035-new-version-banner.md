# 0035. „Neue Version verfügbar“: compare the entry script when the app returns to the foreground

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

A phone keeps the app open in the background for days. `index.html` is served
`no-cache`, but a single-page app never reloads it by itself, so after a deploy
the old bundle keeps running. Matthias didn't see a new form field (in
Haushalt) until he killed the app and reopened it. xitl is the same kind of
app (same stack, same phone use), so it gets the same fix.

## Decision

- When the page becomes visible again (`visibilitychange` → `visible`), fetch
  `/?build-check=<ms>` (`cache: 'no-store'`) and read the hashed entry script
  (`/assets/index-<hash>.js`) out of the returned HTML. Different from the one
  this page was loaded with → show the banner **„Neue Version verfügbar“** with
  a button **„Neu laden“**.
- **No automatic reload.** It could throw away a half-filled sheet. The user
  decides when.
- **At most one check per 60 s**, so flipping between apps costs nothing.
- **`redirect: 'error'`.** An expired Authelia session answers with a redirect
  to the login page; that must not look like a new version. Only a `2xx`
  `text/html` response that contains a hashed entry script counts. Offline,
  server restarting, login page: silently try again next time.
- Nothing runs on the Vite dev server (no hashed bundle, `currentEntry()` is
  null), so development is unaffected.
- **No backend change and no build plugin:** Vite already hashes the entry
  script, and the server already serves `index.html` for `/` (the query is
  ignored). The code is `apps/web/src/lib/appUpdate.svelte.ts` plus
  `UpdateBanner.svelte`, mounted once in `App.svelte`; `main.ts` calls
  `watchForUpdates()`.
- „Neu laden“ first asks the service worker registration to `update()` (the
  deploy may have shipped a new `sw.js` too), then `location.reload()`.
  xitl's worker has no `fetch` handler and no cache (ADR-0009), so the
  check always reaches the network.

## Consequences

- A phone that was away learns about a deploy the moment it is opened again.
- One small extra `GET /` per foreground event, at most once a minute.
- A deploy that changes only the backend, or only `public/` files, doesn't
  change the entry script and shows no banner. Accepted.
- Detection relies on Vite's `/assets/index-<hash>.js` naming. If that
  changes, `entryScript` returns null and the banner silently never shows
  (covered by the unit test on a real Vite snippet).

## Alternatives considered

- **Reload automatically:** can kill a half-filled form. Rejected.
- **`version.json` written by a build plugin:** an extra build step and file to
  keep in sync, while the hashed entry script already is the version.
- **Polling on an interval:** wakes the radio for nothing; the problem is only
  "app comes back after days", which `visibilitychange` covers.
- **Service-worker update detection:** xitl's worker is push-only by
  design (ADR-0009); making it responsible for app updates would add exactly
  the caching this app avoids.
