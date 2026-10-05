// Upstream registry API: TC-05, TC-06, TC-07 (ADR-0010, ADR-0013).
import { test, expect } from '@playwright/test';
import { ANNA, MATTHIAS, createUpstream, dbAll, dbRun, uniqSlug } from './../support/db.js';
import { FAKE_UPSTREAM } from '../support/paths.js';

test.use({ extraHTTPHeaders: {} });

test('TC-05 Upstream anlegen: Felder, Defaults, Validierung (400 deutsch), Slug-Konflikt (409), Slug pro Nutzer', async ({
  request,
}) => {
  const slug = uniqSlug('tc05');
  const res = await request.post('/api/upstreams', {
    headers: MATTHIAS,
    data: { name: 'Haushalt', slug, url: 'https://haushalt.example/mcp', description: 'Aufgaben', defaultPolicy: 'DENY' },
  });
  expect(res.status()).toBe(201);
  const created = await res.json();
  expect(created).toMatchObject({
    slug,
    name: 'Haushalt',
    url: 'https://haushalt.example/mcp',
    description: 'Aufgaben',
    defaultPolicy: 'DENY',
    auth: 'OAUTH',
    status: 'NOT_CONNECTED',
    hasHeaderValue: false,
  });

  // defaults: policy ASK, auth OAUTH
  const def = await request.post('/api/upstreams', {
    headers: MATTHIAS,
    data: { name: 'Defaults', slug: uniqSlug('tc05d'), url: `${FAKE_UPSTREAM}/unused/tc05/mcp` }, // plain http on an allowed address (ADR-0020)
  });
  expect(def.status()).toBe(201);
  expect(await def.json()).toMatchObject({ defaultPolicy: 'ASK', auth: 'OAUTH', description: null });

  // invalid input -> 400 with a German message, nothing created
  const bad: [string, Record<string, unknown>][] = [
    ['slug mit Großbuchstaben', { slug: 'Haushalt' }],
    ['slug mit Unterstrich', { slug: 'haus_halt' }],
    ['slug beginnt mit Bindestrich', { slug: '-abc' }],
    ['slug zu lang', { slug: 'a'.repeat(33) }],
    ['slug leer', { slug: '' }],
    ['slug reserviert (register)', { slug: 'register' }],
    ['slug reserviert (token)', { slug: 'token' }],
    ['url ohne Schema', { url: 'haushalt.example/mcp' }],
    ['url ftp', { url: 'ftp://haushalt.example/mcp' }],
    ['url javascript', { url: 'javascript:alert(1)' }],
    ['name leer', { name: '   ' }],
    ['policy ungültig', { defaultPolicy: 'ALWAYS' }],
    ['auth ungültig', { auth: 'BASIC' }],
    ['HEADER ohne Name/Wert', { auth: 'HEADER' }],
    ['HEADER ohne Wert', { auth: 'HEADER', headerName: 'X-Key' }],
    ['HEADER mit Zeilenumbruch im Wert', { auth: 'HEADER', headerName: 'X-Key', headerValue: 'a\r\nEvil: 1' }],
  ];
  for (const [label, override] of bad) {
    const r = await request.post('/api/upstreams', {
      headers: MATTHIAS,
      data: { name: 'X', slug: uniqSlug('bad'), url: 'https://x.example/mcp', ...override },
    });
    expect(r.status(), label).toBe(400);
    const body = await r.json();
    expect(typeof body.error, label).toBe('string');
    expect(body.error, label).toMatch(/Der|Die|Dieser|Diesen/); // German sentence
  }
  const noBody = await request.post('/api/upstreams', { headers: MATTHIAS, data: 'kein json' });
  expect(noBody.status()).toBe(400);

  // same slug twice for one user -> 409; the same slug for another user is fine
  const dup = await request.post('/api/upstreams', {
    headers: MATTHIAS,
    data: { name: 'Nochmal', slug, url: 'https://x.example/mcp' },
  });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).error).toContain('Slug');
  const other = await request.post('/api/upstreams', {
    headers: ANNA,
    data: { name: 'Annas Haushalt', slug, url: 'https://x.example/mcp' },
  });
  expect(other.status()).toBe(201);

  // PATCH: edit description; renaming the slug onto an existing one is a 409
  const second = await createUpstream(request, MATTHIAS);
  const patched = await request.patch(`/api/upstreams/${created.id}`, {
    headers: MATTHIAS,
    data: { description: 'neu', defaultPolicy: 'ALLOW' },
  });
  expect(patched.status()).toBe(200);
  expect(await patched.json()).toMatchObject({ description: 'neu', defaultPolicy: 'ALLOW', slug });
  const clash = await request.patch(`/api/upstreams/${second.id}`, { headers: MATTHIAS, data: { slug } });
  expect(clash.status()).toBe(409);
  const reserved = await request.patch(`/api/upstreams/${second.id}`, { headers: MATTHIAS, data: { slug: 'token' } });
  expect(reserved.status()).toBe(400);

  // Changing the URL drops a stored connection (tokens must not follow to another server)
  dbRun(
    "update Upstream set status = 'CONNECTED', accessToken = 'at', refreshToken = 'rt' where id = ?",
    second.id,
  );
  const moved = await request.patch(`/api/upstreams/${second.id}`, {
    headers: MATTHIAS,
    data: { url: 'https://elsewhere.example/mcp' },
  });
  expect((await moved.json()).status).toBe('NOT_CONNECTED');
  expect(dbAll('select accessToken, refreshToken from Upstream where id = ?', second.id)[0]).toEqual({
    accessToken: null,
    refreshToken: null,
  });

  // DELETE
  expect((await request.delete(`/api/upstreams/${second.id}`, { headers: MATTHIAS })).status()).toBe(204);
  expect((await request.get(`/api/upstreams/${second.id}`, { headers: MATTHIAS })).status()).toBe(404);

  // no identity -> 401
  expect((await request.get('/api/upstreams')).status()).toBe(401);
});

test('TC-06 Fremder Zugriff: anna bekommt 404 auf GET/PATCH/DELETE und sieht Matthias\' Upstream nicht in der Liste', async ({
  request,
}) => {
  const mine = await createUpstream(request, MATTHIAS, { description: 'privat' });

  expect((await request.get(`/api/upstreams/${mine.id}`, { headers: ANNA })).status()).toBe(404);
  const patch = await request.patch(`/api/upstreams/${mine.id}`, { headers: ANNA, data: { name: 'gekapert' } });
  expect(patch.status()).toBe(404);
  expect((await request.delete(`/api/upstreams/${mine.id}`, { headers: ANNA })).status()).toBe(404);

  const list = await (await request.get('/api/upstreams', { headers: ANNA })).json();
  expect(list.map((u: any) => u.id)).not.toContain(mine.id);
  const own = await (await request.get('/api/upstreams', { headers: MATTHIAS })).json();
  expect(own.map((u: any) => u.id)).toContain(mine.id);

  // nothing changed, nothing deleted
  const row = dbAll('select name, description from Upstream where id = ?', mine.id);
  expect(row).toEqual([{ name: mine.name, description: 'privat' }]);
  // 404 body looks like a missing id's
  const missing = await request.get('/api/upstreams/999999', { headers: ANNA });
  const foreign = await request.get(`/api/upstreams/${mine.id}`, { headers: ANNA });
  expect(await foreign.text()).toBe(await missing.text());
  // junk ids
  expect((await request.get('/api/upstreams/abc', { headers: MATTHIAS })).status()).toBe(404);
});

test('TC-07 Keine Credentials in Antworten (Liste, Einzel, Anlegen, Ändern), auch wenn sie in der DB stehen', async ({
  request,
}) => {
  const SECRETS = ['accessToken', 'refreshToken', 'headerValue', 'oauthClient', 'pendingAuth'];
  const MARKER = 'SECRET-MARKER-' + Date.now();
  const check = (text: string, where: string) => {
    for (const key of SECRETS) expect(text, `${where}: Feldname ${key}`).not.toContain(key);
    expect(text, `${where}: Wert`).not.toContain(MARKER);
  };

  // create with a header credential: the response must not echo the value
  const slug = uniqSlug('tc07');
  const created = await request.post('/api/upstreams', {
    headers: MATTHIAS,
    data: { name: 'Mit Header', slug, url: 'https://x.example/mcp', auth: 'HEADER', headerName: 'X-Api-Key', headerValue: MARKER },
  });
  expect(created.status()).toBe(201);
  const createdText = await created.text();
  check(createdText, 'create');
  const body = JSON.parse(createdText);
  expect(body).toMatchObject({ auth: 'HEADER', headerName: 'X-Api-Key', hasHeaderValue: true });
  const id = body.id as number;

  // fill every credential column directly in the DB
  dbRun(
    `update Upstream set accessToken = ?, refreshToken = ?, oauthClient = ?, oauthMetadata = ?, pendingAuth = ?, instructions = ? where id = ?`,
    MARKER, MARKER, MARKER, MARKER, MARKER, MARKER, id,
  );

  check(await (await request.get('/api/upstreams', { headers: MATTHIAS })).text(), 'list');
  check(await (await request.get(`/api/upstreams/${id}`, { headers: MATTHIAS })).text(), 'get');
  const patched = await request.patch(`/api/upstreams/${id}`, { headers: MATTHIAS, data: { description: 'geändert' } });
  expect(patched.status()).toBe(200);
  check(await patched.text(), 'patch');
  // the write-only value survives a patch that doesn't mention it
  expect(dbAll('select headerValue from Upstream where id = ?', id)[0].headerValue).toBe(MARKER);

  // only the whitelisted keys are present
  expect(Object.keys(JSON.parse(await patched.text())).sort()).toEqual(
    ['auth', 'createdAt', 'defaultPolicy', 'description', 'hasHeaderValue', 'headerName', 'id', 'name', 'slug', 'status', 'updatedAt', 'url'],
  );

  // switching away from HEADER clears the stored value
  const none = await request.patch(`/api/upstreams/${id}`, { headers: MATTHIAS, data: { auth: 'NONE' } });
  expect(await none.json()).toMatchObject({ auth: 'NONE', headerName: null, hasHeaderValue: false });
  check(await none.text(), 'patch-none');
});
