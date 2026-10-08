// Notice when a deploy shipped a newer build than the one this page runs.
// A phone keeps the app open in the background for days; index.html is
// `no-cache`, but a single-page app never reloads it on its own, so the old
// bundle keeps running. When the page comes back to the foreground we fetch
// index.html and compare its hashed entry script with ours.

/** Path of the hashed entry script (`/assets/index-<hash>.js`) an index.html loads, or null. */
export function entryScript(html: string): string | null {
  const m = /<script\b[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/.exec(html);
  return m ? new URL(m[1], 'http://x').pathname : null;
}

/** The entry script this page was loaded with; null on the Vite dev server (no hashed bundle). */
function currentEntry(): string | null {
  const src = document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  return src ? new URL(src, location.href).pathname : null;
}

export const appUpdate = $state({ available: false });

const MIN_GAP_MS = 60_000;
let lastCheck = 0;

export async function checkForUpdate(): Promise<void> {
  const current = currentEntry();
  if (!current || appUpdate.available) return;
  const now = Date.now();
  if (now - lastCheck < MIN_GAP_MS) return;
  lastCheck = now;
  try {
    // `redirect: 'error'`: an expired Authelia session answers with a
    // redirect to the login page, which must not count as a new version.
    const res = await fetch(`/?build-check=${now}`, { cache: 'no-store', redirect: 'error' });
    if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) return;
    const latest = entryScript(await res.text());
    if (latest && latest !== current) appUpdate.available = true;
  } catch {
    // Offline, session expired, server restarting: try again next time.
  }
}

/** Check whenever the app comes back to the foreground. Call once at startup. */
export function watchForUpdates(): void {
  if (!currentEntry()) return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate();
  });
}

export async function reloadApp(): Promise<void> {
  try {
    // Pick up a new service worker too, if the deploy shipped one.
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch {
    // Not a reason to skip the reload, which is what fetches the new build.
  }
  location.reload();
}
