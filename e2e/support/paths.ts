// Paths and network coordinates for the e2e harness. Everything lives under
// .e2e/ (gitignored), fully separate from the dev DB.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — two levels up from e2e/support/. */
export const ROOT = path.resolve(here, '../..');

export const E2E_DIR = path.join(ROOT, '.e2e');
export const DB_PATH = path.join(E2E_DIR, 'e2e.db');
export const DATABASE_URL = `file:${DB_PATH}`;
export const REPORT_DIR = path.join(E2E_DIR, 'report');
export const TEST_RESULTS_DIR = path.join(E2E_DIR, 'test-results');

// Dev servers own 3002/5175; rezepte 3000/5173/3101/3102, haushalts-todos
// 3001/5174/3201 — never collide with those.
export const PORT = 3202;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const WEB_DIST = path.join(ROOT, 'apps/web/dist');
export const SERVER_ENTRY = path.join(ROOT, 'apps/api/dist/index.js');

// The built server mounts /mcp/<slug> only when MCP_TOKEN is set. It is the HMAC
// secret that signs the OAuth codes/tokens, never a bearer (ADR-0012); TC-12
// sends it as one to prove it is rejected.
export const MCP_TOKEN = 'e2e-test-mcp-token';

// The fake upstream (e2e/support/fakeUpstream.ts): OAuth AS + MCP server, a
// second Playwright webServer. Tenants live under /t/<tenant>/.
export const FAKE_UPSTREAM_PORT = 3210;
export const FAKE_UPSTREAM = `http://127.0.0.1:${FAKE_UPSTREAM_PORT}`;
/** A second fake host (same process, another port) that only records what it
 * receives: the target of the fake's malicious redirects (TC-47). */
export const FAKE_SINK_PORT = 3211;
export const FAKE_SINK = `http://127.0.0.1:${FAKE_SINK_PORT}`;
/** HEADER-auth credential the fake accepts instead of a bearer. */
export const FAKE_HEADER_NAME = 'X-Fake-Key';
export const FAKE_HEADER_SECRET = 'fake-header-secret-0123456789';
/** The built server's stdout+stderr (TC-18 greps it for leaked tokens). */
export const API_LOG = path.join(E2E_DIR, 'api.log');

// Push (ADR-0009): the server appends every would-be push as a JSON line here
// instead of sending it (PUSH_OUTBOX, copied from haushalts-todos).
export const PUSH_OUTBOX = path.join(E2E_DIR, 'push-outbox.jsonl');
// A held (ASK) call waits this long for a decision in e2e instead of 300 s.
export const APPROVAL_TIMEOUT_MS = 5000;
