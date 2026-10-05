// ADR-0020 (unit): outbound address policy. docs/testing.md, "Outbound address
// policy". The fetch/agent cases use a throwaway local HTTP server on
// 127.0.0.1 (the only network these tests touch) to prove the guard sits in
// the connection itself, not just in a pre-check.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  OutboundBlocked,
  checkUrlHost,
  isAllowedUrl,
  isBlockedAddress,
  makeGuardedLookup,
  outboundFetch,
  parseAllowList,
  pushAgentFor,
  type Resolver,
} from './outbound.js';

describe('classifier', () => {
  const cases: [string, boolean][] = [
    // edges of every IPv4 range, inside and just outside
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['1.0.0.0', false],
    ['9.255.255.255', false],
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['11.0.0.0', false],
    ['100.63.255.255', false],
    ['100.64.0.0', true],
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['126.255.255.255', false],
    ['127.0.0.0', true],
    ['127.255.255.255', true],
    ['128.0.0.0', false],
    ['169.253.255.255', false],
    ['169.254.0.0', true],
    ['169.254.169.254', true],
    ['169.254.255.255', true],
    ['169.255.0.0', false],
    ['172.15.255.255', false],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['191.255.255.255', false],
    ['192.0.0.0', true],
    ['192.0.0.255', true],
    ['192.0.1.0', false],
    ['192.167.255.255', false],
    ['192.168.0.0', true],
    ['192.168.255.255', true],
    ['192.169.0.0', false],
    ['198.17.255.255', false],
    ['198.18.0.0', true],
    ['198.19.255.255', true],
    ['198.20.0.0', false],
    ['223.255.255.255', false],
    ['224.0.0.0', true],
    ['239.255.255.255', true],
    ['240.0.0.0', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['104.20.23.154', false],
    // IPv6
    ['::', true],
    ['::1', true],
    ['[::1]', true],
    ['fe80::1', true],
    ['fe80::1%eth0', true],
    ['febf:ffff::1', true],
    ['fec0::1', false],
    ['fc00::1', true],
    ['fd00::1', true],
    ['fdff:ffff::1', true],
    ['fe00::1', false],
    ['ff02::1', true],
    ['ff00::', true],
    ['2001:4860::1', false],
    ['2001:4860:4860::8888', false],
    // embedded IPv4, judged by it
    ['::ffff:10.0.0.1', true],
    ['::ffff:a00:1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:8.8.8.8', false],
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::808:808', false],
    ['2002:7f00:1::', true],
    ['2002:a9fe:a9fe::1', true],
    ['2002:808:808::1', false],
    ['::7f00:1', true],
    // unparseable -> blocked (fail closed)
    ['', true],
    ['localhost', true],
    ['1.2.3', true],
    ['256.1.1.1', true],
    ['1:2:3:4:5:6:7:8:9', true],
  ];
  test.each(cases)('%s blocked=%s', (ip, blocked) => {
    expect(isBlockedAddress(ip)).toBe(blocked);
  });
});

describe('exception list', () => {
  test('host, host:port, [v6]:port; case and whitespace; garbage ignored', () => {
    const { entries, invalid } = parseAllowList(
      ' Haushalt.Example.org , 127.0.0.1:3210,[::1]:3210 ,[::1], , foo bar, http://x, x:0, x:99999, ::1, 2130706433, [zz]:1, a/b',
    );
    expect(entries).toEqual([
      { host: 'haushalt.example.org' },
      { host: '127.0.0.1', port: 3210 },
      { host: '[::1]', port: 3210 },
      { host: '[::1]' },
    ]);
    expect(invalid).toEqual(['foo bar', 'http://x', 'x:0', 'x:99999', '::1', '2130706433', '[zz]:1', 'a/b']);
    expect(parseAllowList(undefined)).toEqual({ entries: [], invalid: [] });
    expect(parseAllowList('')).toEqual({ entries: [], invalid: [] });
  });

  test('IPv6 entries are stored canonically', () => {
    expect(parseAllowList('[0:0::1]:80').entries).toEqual([{ host: '[::1]', port: 80 }]);
  });

  test('matched by the URL host (+port), never by resolution', () => {
    const list = parseAllowList('127.0.0.1:3210,haushalt.lan,[::1]:3210').entries;
    expect(isAllowedUrl(new URL('http://127.0.0.1:3210/t/x/mcp'), list)).toBe(true);
    expect(isAllowedUrl(new URL('http://127.0.0.1:3211/'), list)).toBe(false);
    expect(isAllowedUrl(new URL('http://127.0.0.1/'), list)).toBe(false);
    expect(isAllowedUrl(new URL('http://localhost:3210/'), list)).toBe(false);
    expect(isAllowedUrl(new URL('http://HAUSHALT.lan/mcp'), list)).toBe(true);
    expect(isAllowedUrl(new URL('https://haushalt.lan:8443/mcp'), list)).toBe(true);
    expect(isAllowedUrl(new URL('http://sub.haushalt.lan/'), list)).toBe(false);
    expect(isAllowedUrl(new URL('http://[::1]:3210/'), list)).toBe(true);
    expect(isAllowedUrl(new URL('http://[::1]:3211/'), list)).toBe(false);
    // default ports count as the port
    const def = parseAllowList('a.lan:443,b.lan:80').entries;
    expect(isAllowedUrl(new URL('https://a.lan/'), def)).toBe(true);
    expect(isAllowedUrl(new URL('http://a.lan/'), def)).toBe(false);
    expect(isAllowedUrl(new URL('http://b.lan/'), def)).toBe(true);
  });
});

describe('guarded lookup', () => {
  const fake =
    (answers: Record<string, { address: string; family: number }[]>): Resolver =>
    (hostname, _opts, cb) =>
      setImmediate(() => {
        const a = answers[hostname];
        if (!a) cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), []);
        else cb(null, a);
      });
  const lookup = makeGuardedLookup(
    fake({
      'public.test': [
        { address: '93.184.215.14', family: 4 },
        { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
      ],
      'mixed.test': [
        { address: '93.184.215.14', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      'mapped.test': [{ address: '::ffff:192.168.1.1', family: 6 }],
      'odd.test': [{ address: '1.2.3.4', family: 5 }],
    }),
  );
  const call = (host: string, options: unknown) =>
    new Promise<{ err: unknown; address: unknown; family: unknown }>((done) =>
      lookup(host, options, (err, address, family) => done({ err, address, family })),
    );

  test('all: false -> first address and family', async () => {
    expect(await call('public.test', { all: false })).toEqual({ err: null, address: '93.184.215.14', family: 4 });
    expect(await call('public.test', {})).toEqual({ err: null, address: '93.184.215.14', family: 4 });
    expect(await call('public.test', 4)).toEqual({ err: null, address: '93.184.215.14', family: 4 });
  });

  test('all: true -> the whole list', async () => {
    const r = await call('public.test', { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toHaveLength(2);
  });

  test('one blocked address among several -> OutboundBlocked (both call shapes)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const options of [{ all: true }, { all: false }]) {
      const r = await call('mixed.test', options);
      expect(r.err).toBeInstanceOf(OutboundBlocked);
      expect((r.err as OutboundBlocked).hostname).toBe('mixed.test');
    }
    expect((await call('mapped.test', { all: true })).err).toBeInstanceOf(OutboundBlocked);
    expect((await call('odd.test', { all: true })).err).toBeInstanceOf(OutboundBlocked);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mixed.test'));
    warn.mockRestore();
  });

  test('a resolver error passes through unchanged', async () => {
    expect(((await call('missing.test', { all: true })).err as { code?: string }).code).toBe('ENOTFOUND');
  });
});

describe('save-time check', () => {
  const resolve: Resolver = (hostname, _o, cb) => {
    if (hostname === 'intern.test') return cb(null, [{ address: '192.168.1.10', family: 4 }]);
    if (hostname === 'public.test') return cb(null, [{ address: '8.8.8.8', family: 4 }]);
    cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), []);
  };
  test('literals, names, unresolvable, exception list', async () => {
    const allow = parseAllowList('127.0.0.1:3210,intern.test').entries;
    const check = (u: string) => checkUrlHost(u, { allow, resolve });
    expect(await check('http://127.0.0.1:3211/mcp')).toBe('blocked');
    expect(await check('http://127.0.0.1:3210/mcp')).toBe('ok');
    expect(await check('http://[::ffff:127.0.0.1]:3211/')).toBe('blocked');
    expect(await check('http://2130706433:3211/')).toBe('blocked');
    expect(await check('http://169.254.169.254/')).toBe('blocked');
    expect(await check('https://8.8.8.8/')).toBe('ok');
    expect(await check('https://public.test/mcp')).toBe('ok');
    expect(await check('https://nowhere.test/mcp')).toBe('ok');
    expect(await check('https://intern.test/mcp')).toBe('ok');
    expect(await checkUrlHost('https://intern.test/mcp', { allow: [], resolve })).toBe('blocked');
    expect(await check('not a url')).toBe('blocked');
  });
});

describe('outboundFetch / push agent against a real local server', () => {
  let server: http.Server;
  let port = 0;
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      if (req.url === '/redir') {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      res.end('hello');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test('a NAME resolving to 127.0.0.1 is refused by the connect-time lookup (the dispatcher is really used)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = hits;
    await expect(outboundFetch(`http://localhost:${port}/secret/path?token=x`, undefined, { allow: [] })).rejects.toBeInstanceOf(
      OutboundBlocked,
    );
    expect(hits).toBe(before);
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('blocked');
    expect(line).toContain('localhost');
    expect(line).not.toContain('secret');
    expect(line).not.toContain('token');
    warn.mockRestore();
  });

  test('an IP literal is refused before connecting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = hits;
    for (const u of [`http://127.0.0.1:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://2130706433:${port}/`]) {
      await expect(outboundFetch(u, undefined, { allow: [] })).rejects.toBeInstanceOf(OutboundBlocked);
    }
    expect(hits).toBe(before);
    warn.mockRestore();
  });

  test('a host on the exception list goes through (by name, with its port)', async () => {
    const before = hits;
    const viaName = await outboundFetch(`http://localhost:${port}/`, undefined, { allow: parseAllowList(`localhost:${port}`).entries });
    expect(await viaName.text()).toBe('hello');
    const viaIp = await outboundFetch(`http://127.0.0.1:${port}/`, undefined, { allow: parseAllowList('127.0.0.1').entries });
    expect(await viaIp.text()).toBe('hello');
    expect(hits).toBe(before + 2);
    // another port on the same name is not covered by a host:port entry
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(outboundFetch(`http://localhost:${port}/`, undefined, { allow: parseAllowList(`localhost:1`).entries })).rejects.toBeInstanceOf(
      OutboundBlocked,
    );
    warn.mockRestore();
  });

  test('redirects are refused even when the caller asks to follow them', async () => {
    const allow = parseAllowList('127.0.0.1').entries;
    const before = hits;
    await expect(outboundFetch(`http://127.0.0.1:${port}/redir`, { redirect: 'follow' }, { allow })).rejects.toThrow();
    expect(hits).toBe(before + 1);
  });

  test('web push: blocked literal throws, a name goes through the guarded https.Agent lookup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => pushAgentFor('https://127.0.0.1/x', [])).toThrow(OutboundBlocked);
    expect(() => pushAgentFor('https://10.0.0.1/x', [])).toThrow(OutboundBlocked);
    const agent = pushAgentFor(`https://localhost:${port}/x`, []);
    expect(agent).toBeInstanceOf(https.Agent);
    const err = await new Promise<unknown>((done) => {
      const req = https.request(`https://localhost:${port}/x`, { agent, method: 'POST' }, () => done(null));
      req.on('error', done);
      req.end();
    });
    expect(err).toBeInstanceOf(OutboundBlocked);
    expect(pushAgentFor('https://fcm.googleapis.com/fcm/send/x', [])).toBe(agent);
    expect(pushAgentFor(`https://localhost:${port}/x`, parseAllowList('localhost').entries)).not.toBe(agent);
    warn.mockRestore();
  });
});

describe('guard coverage', () => {
  test('no fetch( call in apps/api/src outside lib/outbound.ts (generated and tests excluded)', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated' && entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.(ts|js|mts|cts)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
        if (path.relative(src, full) === path.join('lib', 'outbound.ts')) continue;
        const text = fs.readFileSync(full, 'utf8');
        // bare fetch( / globalThis.fetch( / undici's fetch; method calls like
        // `handler.fetch(` (inbound Hono apps) are fine.
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          // whole-line comments may mention "fetch (…)" in prose
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/(^|[^.\w$])fetch\s*\(|globalThis\s*\.\s*fetch\b|\bundici\b/.test(line)) offenders.push(`${path.relative(src, full)}:${i + 1}`);
        });
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
