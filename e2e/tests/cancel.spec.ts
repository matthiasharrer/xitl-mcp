// The client cancels a held call (`notifications/cancelled`, MCP): TC-132.
import { test, expect } from '@playwright/test';
import { MATTHIAS, uniq } from '../support/db.js';
import { MCP_HEADERS, runOAuthFlow } from '../support/mcpClient.js';
import { BASE_URL } from '../support/paths.js';
import { askUpstream, decide, lastAudit, pendingList, waitPending } from '../support/approval.js';

test.use({ extraHTTPHeaders: {} });

const post = (slug: string, token: string, body: unknown) =>
  fetch(`${BASE_URL}/mcp/${slug}`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const toolsCall = (id: number | string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'add_item', arguments: { item: 'Eier' } } });
const cancel = (requestId: number | string) => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'User cancelled' } });

test('TC-132 notifications/cancelled beendet den gehaltenen Aufruf sofort (abgelehnt, +aborted); falsche ID, anderer Client: bleibt gehalten', async ({ request }) => {
  const { up, token } = await askUpstream(request, 'tc132');
  const other = await runOAuthFlow(request, uniq('Client tc132 other'), MATTHIAS);

  const started = Date.now();
  const held = post(up.slug, token, toolsCall(4711)).then((r) => r.text());
  const pending = await waitPending(request, up.id, 'add_item');

  // Not the same request: wrong id, or the same id from another client.
  expect((await post(up.slug, token, cancel(4712))).status).toBe(202);
  expect((await post(up.slug, other.accessToken, cancel(4711))).status).toBe(202);
  expect((await post(up.slug, token, cancel('4711'))).status).toBe(202);
  expect((await pendingList(request)).some((p) => p.id === pending.id)).toBe(true);

  // The real cancel.
  expect((await post(up.slug, token, cancel(4711))).status).toBe(202);
  const text = await held;
  expect(Date.now() - started).toBeLessThan(4000); // well before the 5 s e2e timeout
  expect(text).toContain('abgebrochen');
  expect((await pendingList(request)).some((p) => p.id === pending.id)).toBe(false);
  const audit = lastAudit(up.id);
  expect(audit.outcome).toBe('DENIED');
  expect(audit.decisionPath).toMatch(/\+aborted$/);
  // Settled: a late decision finds nothing to approve.
  expect((await decide(request, pending.id, { decision: 'approve' })).status()).not.toBe(200);
});
