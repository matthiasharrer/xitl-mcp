// Mounts the MCP endpoints (ADR-0012, ADR-0014); copied from haushalts-todos'
// mcp/mount.ts and adapted to `/mcp/<slug>`. The one deliberate exception to "no
// login code in the app": Authelia's ForwardAuth covers every other route at the
// ingress; `/mcp*` is carved out of that so an MCP client can reach it without
// an Authelia session, which means the gate below is the *only* thing standing
// between this route and the open internet. Get it right, fail closed.
//
// The gate is the SDK's own `requireBearerAuth` rather than a hand-rolled header
// check: it accepts only a signed OAuth access-token blob (verifier.ts) —
// `MCP_TOKEN` is the HMAC signing secret, NOT an accepted bearer (MCP is
// OAuth-only) — and on rejection answers with the spec's `WWW-Authenticate`
// challenge, including `resource_metadata`, so a client that hasn't done
// discovery yet can still find its way there. The OAuth discovery/DCR endpoints
// (oauthRoutes.ts) are mounted first, before `/mcp/:slug` and well before
// `mountStatic`'s wildcard (app.ts).
//
// Routing (ADR-0014): `/mcp/<slug>` is one of THE CALLER'S OWN upstreams. The
// slug is resolved only after the token is verified and only among the token
// user's upstreams; anything else is a 404 and never another user's server.
// `/mcp` (all upstreams in one) does not exist yet: 404.
import type { Hono } from 'hono';
import type { AppEnv } from '../identity.js';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/server';
import { buildMcpServer } from './server.js';
import { makeVerifier } from './verifier.js';
import { mountMcpOAuth } from './oauthRoutes.js';
import { externalOrigin } from '../lib/externalOrigin.js';
import { isUpstreamSlug } from '../lib/slugs.js';
import { prisma } from '../db.js';

/** `requireBearerAuth`'s documented contract is `AuthInfo | Response`, checked
 * with `result instanceof Response` (see the SDK's own example). That check
 * is unsound in this app: `@hono/node-server`'s `serve()` replaces
 * `globalThis.Response` with its own lightweight subclass the first time it
 * handles a request (`overrideGlobalObjects`, on by default) — but the SDK
 * built its 401/403 challenge earlier via a closed-over reference to the
 * *original* native `Response`. The challenge object is a genuine `Response`
 * by any structural test, but `instanceof` against the now-current,
 * `@hono/node-server`-owned `Response` returns **false** for it — which,
 * followed naively, would hand the challenge straight to the MCP handler as
 * if it were a validated `AuthInfo`, an outright auth bypass — reproduced in
 * isolation (a bare `serve()` + one route, no MCP SDK involved) before this
 * guard was written. Duck-typing `AuthInfo`'s own shape instead sidesteps
 * the class-identity question entirely — it's correct no matter which
 * `Response` implementation produced the rejection. */
function isAuthInfo(value: AuthInfo | Response): value is AuthInfo {
  return typeof (value as AuthInfo).token === 'string' && typeof (value as AuthInfo).clientId === 'string';
}

const NOT_FOUND = { error: 'Not found' };

export function mountMcp(app: Hono<AppEnv>): void {
  const token = process.env.MCP_TOKEN;
  if (!token) {
    console.log('MCP disabled (MCP_TOKEN not set).');
    return;
  }

  // Built once at mount time and reused for every request: the v2 SDK's
  // handler is per-exchange stateless already (buildMcpServer is the
  // per-request factory it calls internally, with the request's authInfo), so
  // there's nothing to gain from rebuilding the handler itself on every call.
  const handler = createMcpHandler(buildMcpServer);
  const verifier = makeVerifier(token);

  // First: /mcp/register and /mcp/token (and the other OAuth routes) must win
  // over `/mcp/:slug` below. Hono matches in registration order.
  mountMcpOAuth(app, token);

  // The aggregated endpoint comes with the second upstream (ADR-0014).
  app.all('/mcp', (c) => c.json(NOT_FOUND, 404));

  app.all('/mcp/:slug', async (c) => {
    const slug = c.req.param('slug');
    // register/token are the OAuth endpoints (a wrong method on them lands here);
    // anything else that is not a valid slug cannot exist. Neither reveals
    // anything, so no auth is needed to say 404.
    if (!isUpstreamSlug(slug)) return c.json(NOT_FOUND, 404);

    // Built per request, not once at mount time: `resourceMetadataUrl` is
    // origin-dependent, and the origin can legitimately vary request to request
    // (different `X-Forwarded-Host`, or none in a local curl). The slug is
    // validated above, so echoing it into the challenge is safe.
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${externalOrigin(c)}/mcp/${slug}`));
    const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'], resourceMetadataUrl });

    const result = await gate(c.req.raw);
    if (!isAuthInfo(result)) {
      // Re-wrap in the *current* global Response (see isAuthInfo's comment)
      // rather than returning `result` as-is — a foreign Response instance
      // straight out of Hono's own handler is exactly the shape mismatch
      // this whole guard exists to avoid propagating further.
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
    }

    // The token's user comes from the client binding (verifier.ts). Resolve the
    // slug ONLY among that user's upstreams: another user's slug is a 404, same
    // as an unknown one.
    const userId = result.extra?.userId;
    if (typeof userId !== 'number') return c.json(NOT_FOUND, 404); // cannot happen after the verifier; fail closed
    const upstream = await prisma.upstream.findUnique({
      where: { userId_slug: { userId, slug } },
      select: { id: true, slug: true, name: true, description: true },
    });
    if (!upstream) return c.json(NOT_FOUND, 404);

    return handler.fetch(c.req.raw, { authInfo: { ...result, extra: { ...result.extra, upstream } } });
  });

  // Anything deeper under /mcp (e.g. /mcp/foo/bar) is not an endpoint either;
  // without this the SPA fallback would answer a GET with index.html.
  app.all('/mcp/*', (c) => c.json(NOT_FOUND, 404));

  console.log('MCP mounted at /mcp/<slug>.');
}
