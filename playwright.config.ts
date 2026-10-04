// e2e runs against the BUILT single-container server (API + built SPA in one
// Node process), never the Vite dev server or the dev DB.
//
// Workspace trap: if browsers fail with "Executable doesn't exist", run
//   PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npm run e2e
// (see rezepte's CLAUDE.md; the image's /opt browsers lag @playwright/test).
import { defineConfig } from '@playwright/test';
import {
  API_LOG,
  BASE_URL,
  FAKE_UPSTREAM,
  DATABASE_URL,
  MCP_TOKEN,
  PORT,
  REPORT_DIR,
  SERVER_ENTRY,
  TEST_RESULTS_DIR,
  WEB_DIST,
} from './e2e/support/paths.js';

export default defineConfig({
  testDir: './e2e',
  // One server, one SQLite file: no parallel workers.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: TEST_RESULTS_DIR,
  reporter: [['list'], ['html', { outputFolder: REPORT_DIR, open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    // Mobile-first: phone viewport by default.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    locale: 'de-DE',
    trace: 'retain-on-failure',
    // The built server has no ingress in front, so the page's own fetches
    // carry no identity; browser cases supply Remote-User like Traefik would.
    extraHTTPHeaders: { 'Remote-User': 'matthias', 'Remote-Name': 'Matthias (e2e)' },
  },
  webServer: [
    {
      // The server's output goes to .e2e/api.log: TC-18 greps it for leaked
      // upstream tokens. `exec` keeps it one process, so teardown kills it.
      command: `npx tsx e2e/prepare.ts && exec node ${SERVER_ENTRY} > ${API_LOG} 2>&1`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { DATABASE_URL, PORT: String(PORT), WEB_DIST, MCP_TOKEN },
    },
    {
      // OAuth AS + MCP server standing in for real upstreams (docs/testing.md).
      command: 'npx tsx e2e/support/fakeUpstream.ts',
      url: `${FAKE_UPSTREAM}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
