import { test, expect } from '@playwright/test';

// Bare headers per test: these cases set identity themselves.
test.use({ extraHTTPHeaders: {} });

test('TC-01 /api/health answers without identity', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok' });
});

test('TC-02 /api/me without Remote-User is a 401, with it returns the user', async ({ request }) => {
  const anon = await request.get('/api/me');
  expect(anon.status()).toBe(401);

  const me = await request.get('/api/me', {
    headers: { 'Remote-User': 'matthias', 'Remote-Name': 'Matthias (e2e)' },
  });
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ username: 'matthias', displayName: 'Matthias (e2e)' });
});
