// Helpers shared by the API cases: identities, unique names, and direct access
// to the e2e SQLite file (WAL: safe next to the running server). Pattern from
// haushalts-todos' e2e/support/tasks.ts.
import { createRequire } from 'node:module';
import { DB_PATH } from './paths.js';

const require = createRequire(import.meta.url);

export const MATTHIAS = { 'Remote-User': 'matthias', 'Remote-Name': 'Matthias' };
export const ANNA = { 'Remote-User': 'anna', 'Remote-Name': 'Anna' };
// Identities of unified.spec.ts (TC-61…68): own upstreams, so the unified /mcp
// of each sees only what the spec created (matthias's /mcp lists every upstream
// other specs left behind). Never connect an upstream for anna (TC-16).
export const UNI_A = { 'Remote-User': 'uni-a', 'Remote-Name': 'Uli' };
export const UNI_B = { 'Remote-User': 'uni-b', 'Remote-Name': 'Berta' };
export const UNI_DEGRADE = { 'Remote-User': 'uni-degrade', 'Remote-Name': 'Dora' };
// Identities of token-scope.spec.ts (TC-69…72), one per case so /mcp lists only what the case created.
export const TS_UI = { 'Remote-User': 'ts-ui', 'Remote-Name': 'Tilda' };
export const TS_A = { 'Remote-User': 'ts-a', 'Remote-Name': 'Toni' };
export const TS_B = { 'Remote-User': 'ts-b', 'Remote-Name': 'Tessa' };
export const TS_SEC = { 'Remote-User': 'ts-sec', 'Remote-Name': 'Timo' };
export const TS_REV = { 'Remote-User': 'ts-rev', 'Remote-Name': 'Tara' };
export const UNI_EMPTY = { 'Remote-User': 'uni-empty', 'Remote-Name': 'Emil' };

let counter = 0;
/** Unique per test run so cases never see each other's rows. */
export const uniq = (prefix: string) => `${prefix} ${Date.now()}-${++counter}`;
/** A unique, valid slug (<= 32 chars). */
export const uniqSlug = (prefix = 'u') => `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}`;

export function dbAll(sql: string, ...params: unknown[]): any[] {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function dbRun(sql: string, ...params: unknown[]): void {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Creates an upstream through the API; returns the serialized row. */
export async function createUpstream(
  request: import('@playwright/test').APIRequestContext,
  user: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  const slug = (overrides.slug as string | undefined) ?? uniqSlug();
  const res = await request.post('/api/upstreams', {
    headers: user,
    data: { name: `Upstream ${slug}`, slug, url: 'https://example.com/mcp', ...overrides },
  });
  if (res.status() !== 201) throw new Error(`createUpstream failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { id: number; slug: string; name: string };
}
