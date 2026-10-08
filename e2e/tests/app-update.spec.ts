// TC-212…215: "Neue Version verfügbar" banner (ADR-0035). The page compares the
// hashed entry script of a freshly fetched index.html with its own.
import { test, expect, type Page } from '@playwright/test';

const isCheck = (url: URL | string) => new URL(url).searchParams.has('build-check');
const checkUrl = (u: URL) => isCheck(u);
const NEW_BUILD = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-NEUERBUILD.js"></script>
</head><body><div id="app"></div></body></html>`;

/** Load the app, then pretend it comes back to the foreground. */
async function foreground(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'xitl', level: 1 })).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

const banner = (page: Page) => page.getByRole('status').filter({ hasText: 'Neue Version verfügbar' });
const hScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test('TC-212 Gleicher Build: nach der Prüfung kein Hinweis', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'xitl', level: 1 })).toBeVisible();
  const checked = page.waitForResponse((r) => isCheck(r.url()));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const res = await checked;
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('/assets/index-');
  await expect(banner(page)).toHaveCount(0);
});

test('TC-213 Neuer Build: Hinweis erscheint, „Neu laden“ lädt neu und der Hinweis ist weg', async ({ page }) => {
  await page.route(checkUrl, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: NEW_BUILD }),
  );
  await foreground(page);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).getByRole('button', { name: 'Neu laden' })).toBeVisible();
  expect(await hScroll(page)).toBe(false);
  const box = (await banner(page).getByRole('button', { name: 'Neu laden' }).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);

  await page.unroute(checkUrl);
  await Promise.all([
    page.waitForEvent('load'),
    banner(page).getByRole('button', { name: 'Neu laden' }).click(),
  ]);
  await expect(page.getByRole('heading', { name: 'xitl', level: 1 })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  // the reloaded page checks against the real server again: same build, no banner
  const checked = page.waitForResponse((r) => isCheck(r.url()));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await checked;
  await expect(banner(page)).toHaveCount(0);
});

test('TC-214 Prüfung schlägt fehl: kein Hinweis, keine Fehler', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Chromium itself logs the aborted request; that's not the app's doing.
    if (m.type() === 'error' && !m.text().includes('net::ERR_FAILED')) problems.push(`console: ${m.text()}`);
  });
  let hit = false;
  await page.route((u) => isCheck(u), (route) => {
    hit = true;
    return route.abort();
  });
  await foreground(page);
  await expect.poll(() => hit).toBe(true);
  await page.waitForTimeout(300);
  await expect(banner(page)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('TC-215 Login-Weiterleitung (abgelaufene Sitzung): kein Hinweis', async ({ page }) => {
  let hit = false;
  await page.route((u) => isCheck(u), (route) => {
    hit = true;
    return route.fulfill({ status: 302, headers: { location: 'https://auth.example/' } });
  });
  await foreground(page);
  await expect.poll(() => hit).toBe(true);
  await page.waitForTimeout(300);
  await expect(banner(page)).toHaveCount(0);
});
