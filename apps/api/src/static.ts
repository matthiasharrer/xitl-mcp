import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

// Production serves the built SPA from the same process as the API (one
// container, one port). Dev never sets WEB_DIST — Vite handles static
// serving + the SPA fallback itself — so this stays a no-op there.
export function mountStatic(app: Hono): void {
  const webDist = process.env.WEB_DIST;
  if (!webDist) {
    console.log('Static serving disabled (WEB_DIST not set).');
    return;
  }

  const absDist = path.resolve(webDist);
  const indexPath = path.join(absDist, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.log(`Static serving disabled (no index.html in WEB_DIST "${absDist}").`);
    return;
  }

  // Read the shell once at boot rather than per request: it never changes for
  // the lifetime of a container, and the fallback is on the hot path for every
  // deep link — synchronous disk reads there would block the event loop.
  const indexHtml = fs.readFileSync(indexPath, 'utf-8');

  // @hono/node-server's serveStatic resolves `root` relative to process.cwd()
  // and explicitly does not support absolute roots, so we compute the
  // relative path ourselves — this must work no matter which directory the
  // process was started from.
  const root = path.relative(process.cwd(), absDist).split(path.sep).join('/');

  // OPTIONS on the SPA and its files (TC-101). serveStatic treats OPTIONS like
  // HEAD: a 200 with the file's Content-Length and no body, so a client waits
  // for bytes that never come; a path without a file fell through to a 404.
  // The answer is a plain 204 saying what the path supports, and never any
  // `Access-Control-*` (CORS exists only on /mcp and /mcp/<slug>, ADR-0023).
  // The API, OAuth and discovery prefixes keep their own (404) answer; /mcp*
  // is answered by mcp/mount.ts before this is reached.
  const ownAnswer = ['/api/', '/oauth/', '/.well-known/', '/mcp'];
  app.options('*', async (c, next) => {
    if (ownAnswer.some((p) => c.req.path.startsWith(p))) return next();
    return c.body(null, 204, { Allow: 'GET, HEAD' });
  });

  // Content-hashed assets (/assets/*) are safe to cache forever; everything
  // else (notably index.html) must revalidate on every request so a deploy
  // is picked up immediately instead of being stuck behind a stale cache.
  // Never for OPTIONS (see above): it would answer with a length and no body.
  const assets = serveStatic({
    root,
    onFound: (_path, c) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
  const files = serveStatic({
    root,
    onFound: (_path, c) => {
      c.header('Cache-Control', 'no-cache');
    },
  });
  app.use('/assets/*', (c, next) => (c.req.method === 'OPTIONS' ? next() : assets(c, next)));
  app.use('*', (c, next) => (c.req.method === 'OPTIONS' ? next() : files(c, next)));

  // SPA fallback: any GET/HEAD that isn't a real file and isn't under /api
  // gets index.html so client-side routes (e.g. /recipes/3) survive a
  // reload/deep link. Everything under /api that reaches here is an unknown
  // API route, not a client route — it must 404 as JSON, never fall through
  // to the HTML shell (a typo'd endpoint returning HTML is a confusing bug).
  // Only GET/HEAD get the fallback — a POST to an unknown path is just 404.
  app.on(['GET', 'HEAD'], '*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    c.header('Cache-Control', 'no-cache');
    return c.html(indexHtml);
  });
}
