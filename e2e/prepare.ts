// Builds the app and migrates a fresh e2e database immediately before the
// server under test boots. Chained into `webServer.command` with `&&` in
// playwright.config.ts (Playwright's globalSetup runs too late: after the
// server is already up).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { DATABASE_URL, DB_PATH, E2E_DIR, ROOT } from './support/paths.js';

fs.mkdirSync(E2E_DIR, { recursive: true });

const env = { ...process.env, DATABASE_URL };

// E2E_SKIP_BUILD=1 is the iterate-fast escape hatch.
if (process.env.E2E_SKIP_BUILD === '1') {
  console.error('[e2e] E2E_SKIP_BUILD=1 — skipping npm run build');
} else {
  console.error('[e2e] Building web + api…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(DB_PATH + suffix, { force: true });
}

console.error('[e2e] Applying migrations to the e2e DB…');
execFileSync('npx', ['prisma', 'migrate', 'deploy', '--config', 'apps/api/prisma.config.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
});
