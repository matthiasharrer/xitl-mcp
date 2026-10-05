// Housekeeping (ADR-0016 amendment, ADR-0023): TC-100 (sessions expire),
// TC-101 (OPTIONS outside /mcp* never hangs, never carries CORS).
//
// TC-100 writes session rows straight into the e2e DB with old timestamps and
// lets a real `initialize` clean up; the real limits apply (30 days, 500 per
// user). Own users (hk-a, hk-b): the per-user cleanup must not see anyone
// else's rows.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { HK_A, HK_B, dbAll, dbRun, uniq } from '../support/db.js';
import { INITIALIZE, LIST, postMcp } from '../support/mcpClient.js';
import { WEB_DIST } from '../support/paths.js';

test.use({ extraHTTPHeaders: {} });

type User = Record<string, string>;
const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().replace('Z', '+00:00');
const ago = (ms: number) => iso(new Date(Date.now() - ms));
const corsHeaders = (res: APIResponse) => Object.keys(res.headers()).filter((h) => h.toLowerCase().startsWith('access-control-'));

async function userId(request: APIRequestContext, user: User): Promise<number> {
  expect((await request.get('/api/me', { headers: user })).status()).toBe(200);
  return dbAll('select id from User where username = ?', user['Remote-User'])[0].id;
}

/** An all-upstreams access token of `user` (no upstream needed for `/mcp`). */
async function allToken(request: APIRequestContext, user: User, allowedOrigins: string[] = []) {
  const res = await request.post('/api/mcp/tokens', { headers: user, data: { name: uniq('Token hk'), allowedOrigins } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { client: { id: number }; token: string };
}

/** A session row as mount.ts would have written it, last seen `ageMs` ago. */
function insertSession(uid: number, mcpClientId: number, ageMs: number): string {
  const id = crypto.randomBytes(32).toString('base64url');
  const seen = ago(ageMs);
  dbRun(
    'insert into McpSession (id, userId, mcpClientId, upstreamId, clientName, createdAt, lastSeenAt) values (?, ?, ?, null, ?, ?, ?)',
    id,
    uid,
    mcpClientId,
    'TC-100',
    seen,
    seen,
  );
  return id;
}

const sessionExists = (id: string) => dbAll('select id from McpSession where id = ?', id).length === 1;

test('TC-100 Sitzungen laufen ab: initialize entfernt die > 30 Tage alten des Nutzers, Audit bleibt (ohne Sitzung), fremde bleiben, alte id -> 404', async ({ request }) => {
  const uidA = await userId(request, HK_A);
  const uidB = await userId(request, HK_B);
  const a = await allToken(request, HK_A);
  const b = await allToken(request, HK_B);

  const old = insertSession(uidA, a.client.id, 31 * DAY);
  const recent = insertSession(uidA, a.client.id, 1 * DAY);
  const othersOld = insertSession(uidB, b.client.id, 31 * DAY);
  dbRun(
    "insert into AuditEntry (userId, mcpClientId, upstreamId, endpoint, toolName, arguments, policy, decisionPath, outcome, receivedAt, finishedAt, sessionId) values (?, ?, null, '/mcp', 'tc100_tool', '{}', 'ALLOW', 'policy:tool', 'FORWARDED', ?, ?, ?)",
    uidA,
    a.client.id,
    ago(31 * DAY),
    ago(31 * DAY),
    old,
  );
  const auditId = dbAll('select id from AuditEntry where sessionId = ?', old)[0].id as number;

  try {
    // a new initialize of hk-a: makes room first (this user only)
    const init = await postMcp(request, null, a.token, INITIALIZE);
    expect(init.status()).toBe(200);
    const fresh = init.headers()['mcp-session-id']!;
    expect(fresh).toBeTruthy();

    expect(sessionExists(old)).toBe(false);
    expect(sessionExists(recent)).toBe(true);
    expect(sessionExists(fresh)).toBe(true);
    // another user's expired session is untouched by hk-a's create (boot cleanup is unit-only)
    expect(sessionExists(othersOld)).toBe(true);

    // the audit row keeps living, without its session (Verlauf shows none)
    expect(dbAll('select sessionId from AuditEntry where id = ?', auditId)[0]).toEqual({ sessionId: null });
    const detail = await request.get(`/api/audit/${auditId}`, { headers: HK_A });
    expect(detail.status()).toBe(200);
    expect((await detail.json()).session).toBeNull();

    // presenting the deleted id: the same 404 as an unknown one
    const stale = await postMcp(request, null, a.token, LIST, { sessionId: old, headers: { 'MCP-Protocol-Version': '2025-06-18' } });
    expect(stale.status()).toBe(404);
    expect((await stale.json()).error.code).toBe(-32001);
  } finally {
    dbRun('delete from AuditEntry where id = ?', auditId);
    dbRun('delete from McpSession where userId in (?, ?)', uidA, uidB);
  }
});

test('TC-101 OPTIONS außerhalb von /mcp* hängt nie und trägt nie CORS (mit und ohne gelistete Origin)', async ({ request }) => {
  const listed = `https://hk-${crypto.randomBytes(4).toString('hex')}.example`;
  await userId(request, HK_A);
  await allToken(request, HK_A, [listed]);
  const asset = fs.readdirSync(path.join(WEB_DIST, 'assets')).find((f) => f.endsWith('.js'));
  expect(asset, 'built SPA has an /assets/*.js').toBeTruthy();

  // the SPA, its files and an unknown client route: 204, Allow, no body, no CORS
  for (const p of ['/', '/sw.js', `/assets/${asset}`, '/irgendwo']) {
    for (const origin of [undefined, listed]) {
      const res = await request.fetch(p, {
        method: 'OPTIONS',
        headers: origin ? { Origin: origin, 'Access-Control-Request-Method': 'GET' } : {},
        timeout: 2000,
        maxRedirects: 0,
      });
      const label = `OPTIONS ${p} ${origin ?? '(no Origin)'}`;
      expect(res.status(), label).toBe(204);
      expect(res.headers()['allow'], label).toBe('GET, HEAD');
      expect(Number(res.headers()['content-length'] ?? '0'), label).toBe(0);
      expect((await res.body()).length, label).toBe(0);
      expect(corsHeaders(res), label).toEqual([]);
    }
  }

  // API, OAuth and discovery: their own answer (status as before), in time, no CORS
  for (const p of ['/api/upstreams', '/oauth/authorize', '/.well-known/oauth-authorization-server']) {
    for (const headers of [{}, { Origin: listed }, { Origin: listed, ...HK_A }]) {
      const res = await request.fetch(p, { method: 'OPTIONS', headers, timeout: 2000, maxRedirects: 0 });
      await res.body();
      expect(corsHeaders(res), `OPTIONS ${p}`).toEqual([]);
    }
  }
});
