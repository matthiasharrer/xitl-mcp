// Mounts the MCP endpoints (ADR-0012, ADR-0014); copied from haushalts-todos'
// mcp/mount.ts and adapted to `/mcp/<slug>`. The one deliberate exception to "no
// login code in the app": Authelia's ForwardAuth covers every other route at the
// ingress; `/mcp*` is carved out of that so an MCP client can reach it without
// an Authelia session, which means the gate below is the *only* thing standing
// between this route and the open internet. Get it right, fail closed.
//
// Two bearer shapes (ADR-0015, ADR-0018): `xitl_…` is an access token, checked
// ONLY against its hash, its scope and the endpoint (verifier.ts, makeGateVerifier);
// anything else is checked ONLY as an OAuth blob. Both fail with the same 401
// challenge.
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
// `/mcp` is all of the caller's upstreams in one (ADR-0017): OAuth or an
// all-upstreams access token (ADR-0018; a one-upstream token gets the 401
// challenge there), and the server
// (server.ts) resolves each call's `<slug>_` prefix among the user's upstreams.
//
// Browser clients (ADR-0023, cors.ts), on `/mcp` and `/mcp/<slug>` only. The
// order per request is:
//   1. `OPTIONS` with an `Origin` (preflight, no token): answered BEFORE the
//      bearer gate - 204 + CORS headers when some token lists the origin,
//      else 403 without any `Access-Control-*`. (OPTIONS without Origin: as
//      before, through the gate.)
//   2. Bearer gate (token verified; verifier.ts no longer writes anything).
//      A rejection carrying an Origin that some token lists gets the CORS
//      headers too, so the page can read the 401.
//   3. Origin check: the client row is re-read (scoped by user). A TOKEN
//      client whose list doesn't contain the request's Origin -> 403
//      `origin_not_allowed`, before anything else happens. OAuth clients:
//      no check, no CORS headers.
//   4. `lastUsedAt` of a TOKEN client (verifier.touchTokenLastUsed).
//   5. Slug resolution, body peek, sessions, the MCP handler. Every response
//      from here on carries the CORS headers when the origin was allowed
//      (withCors wraps the headers, the body streams through).
// Requests without `Origin` (every server-side client) skip 1-3's CORS parts.
//
// Sessions (ADR-0016, sessions.ts): a 2025-era `initialize` gets an
// `Mcp-Session-Id` (a DB row, no transport or server kept in memory); a later
// request carrying it must match user + client + upstream and not be ended, or
// it gets the SDK's 404 "Session not found"; `DELETE` with it ends the
// session. On `/mcp` the session has no upstream, and the two kinds never
// match each other. Requests without the header are served sessionless, as always.
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../identity.js';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/server';
import { buildMcpServer } from './server.js';
import { makeGateVerifier, makeVerifier, touchTokenLastUsed } from './verifier.js';
import { originListedByAnyToken, preflight, withCors } from './cors.js';
import { normalizeOrigin, originListed } from '../lib/origins.js';
import { mountMcpOAuth } from './oauthRoutes.js';
import { externalOrigin } from '../lib/externalOrigin.js';
import { isUpstreamSlug } from '../lib/slugs.js';
import { prisma } from '../db.js';
import { systemClock } from '../lib/clock.js';
import { errorTag } from '../upstream/oauthClient.js';
import { MAX_MCP_BODY_BYTES } from '../lib/limits.js';
import {
  createSession,
  echoableId,
  endSession,
  findOwnSession,
  legacyInitializeOf,
  messagesOf,
  requestDiagnostics,
  sessionNotFound,
  touchSession,
  type SessionRow,
} from './sessions.js';

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

/** Bodies larger than this are not peeked at (the body limit middleware
 * refuses anything above MAX_MCP_BODY_BYTES anyway). */
const PEEK_MAX_BYTES = MAX_MCP_BODY_BYTES;

interface Peek {
  messages: Record<string, unknown>[];
  isBatch: boolean;
}

/** Reads at most `max` bytes of a stream as text; null when it is longer. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses a POST body from a clone (the handler reads the original). A hint
 * for instructions, session bookkeeping and diagnostics only: never decides
 * who may do what. Bodies without a declared length (chunked; common behind
 * HTTP/2 ingresses) are read too, capped at PEEK_MAX_BYTES. null when not
 * peekable (too large, not JSON). */
async function peekBody(req: Request): Promise<Peek | null> {
  if (req.method !== 'POST' || !req.body) return null;
  const declared = req.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= PEEK_MAX_BYTES)) return null;
  try {
    const text = await readCapped(req.clone().body!, PEEK_MAX_BYTES);
    if (text === null) return null;
    const body = JSON.parse(text) as unknown;
    return { messages: messagesOf(body), isBatch: Array.isArray(body) };
  } catch {
    return null;
  }
}

function wantsInstructionsOf(peek: Peek | null): boolean {
  return !!peek?.messages.some((m) => m.method === 'initialize' || m.method === 'server/discover');
}

/** The handler's response with `Mcp-Session-Id` added (body passed through,
 * so an SSE stream keeps streaming). */
function withSessionHeader(res: Response, id: string): Response {
  const headers = new Headers(res.headers);
  headers.set('Mcp-Session-Id', id);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
  const oauthVerifier = makeVerifier(token);

  // First: /mcp/register and /mcp/token (and the other OAuth routes) must win
  // over `/mcp/:slug` below. Hono matches in registration order.
  mountMcpOAuth(app, token);

  /** One request to `/mcp/<slug>` (slug validated) or `/mcp` (slug null). */
  async function serve(c: Context<AppEnv>, slug: string | null): Promise<Response> {
    const path = slug === null ? '/mcp' : `/mcp/${slug}`;
    // ADR-0023 step 1: a CORS preflight carries no token; answered here.
    const requestOrigin = c.req.header('origin');
    if (c.req.method === 'OPTIONS' && requestOrigin !== undefined) return preflight(requestOrigin);
    // Built per request, not once at mount time: `resourceMetadataUrl` is
    // origin-dependent, and the origin can legitimately vary request to request
    // (different `X-Forwarded-Host`, or none in a local curl). The slug is
    // validated by the caller, so echoing it into the challenge is safe.
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${externalOrigin(c)}${path}`));
    const gate = requireBearerAuth({ verifier: makeGateVerifier(oauthVerifier, slug), requiredScopes: ['mcp'], resourceMetadataUrl });

    const result = await gate(c.req.raw);
    if (!isAuthInfo(result)) {
      // Re-wrap in the *current* global Response (see isAuthInfo's comment)
      // rather than returning `result` as-is — a foreign Response instance
      // straight out of Hono's own handler is exactly the shape mismatch
      // this whole guard exists to avoid propagating further.
      const rejected = new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
      // ADR-0023: the 401 challenge is readable by a page whose origin some token lists.
      if (requestOrigin !== undefined && rejected.status === 401 && (await originListedByAnyToken(requestOrigin))) {
        return withCors(rejected, normalizeOrigin(requestOrigin)!);
      }
      return rejected;
    }

    const userId = result.extra?.userId;
    if (typeof userId !== 'number') return c.json(NOT_FOUND, 404); // cannot happen after the verifier; fail closed
    const mcpClientId = result.extra?.mcpClientId;
    if (typeof mcpClientId !== 'number') return c.json(NOT_FOUND, 404); // cannot happen after the verifier; fail closed

    // ADR-0023 step 3: the browser origin, against the verified client's own
    // list (read fresh, scoped). Before anything else: no server is built,
    // nothing is audited or touched, no upstream contacted.
    const client = await prisma.mcpClient.findFirst({ where: { id: mcpClientId, userId }, select: { kind: true, allowedOrigins: true } });
    if (!client) return c.json(NOT_FOUND, 404); // revoked mid-request; fail closed
    let corsOrigin: string | null = null;
    if (requestOrigin !== undefined && client.kind === 'TOKEN') {
      if (!originListed(requestOrigin, client.allowedOrigins)) return c.json({ error: 'origin_not_allowed' }, 403);
      corsOrigin = normalizeOrigin(requestOrigin);
    }
    // Every response from here on: readable by the allowed page (OAuth / no Origin: unchanged).
    const out = (res: Response) => (corsOrigin ? withCors(res, corsOrigin) : res);

    // ADR-0023 step 4 (ADR-0015): "last used", only for a request let through.
    if (client.kind === 'TOKEN') touchTokenLastUsed(mcpClientId, userId);

    // The token's user comes from the client binding (verifier.ts). Resolve the
    // slug ONLY among that user's upstreams: another user's slug is a 404, same
    // as an unknown one.
    let upstream: { id: number; slug: string; name: string; description: string | null } | null = null;
    if (slug !== null) {
      upstream = await prisma.upstream.findUnique({
        where: { userId_slug: { userId, slug } },
        select: { id: true, slug: true, name: true, description: true },
      });
      if (!upstream) return out(c.json(NOT_FOUND, 404));
    }

    const owner = { userId, mcpClientId, upstreamId: upstream?.id ?? null };

    // Peek at the JSON-RPC body (on a clone; the handler reads the original)
    // so the server factory only contacts the upstream(s) for instructions
    // when the client actually asks for them, and for session bookkeeping.
    const peek = await peekBody(c.req.raw);
    const wantsInstructions = wantsInstructionsOf(peek);
    const messages = peek?.messages ?? [];

    // Sessions (ADR-0016, mcp/sessions.ts) — only AFTER the token check: a
    // session id is never a credential. A 2025-era `initialize` starts a new
    // session (any id it carries is ignored, as the spec has it); otherwise a
    // presented id must be this caller's own open session, or 404. No header
    // at all: sessionless, exactly as before.
    const init = legacyInitializeOf(messages);
    const presented = c.req.header('mcp-session-id');
    let session: SessionRow | null = null;
    if (!init && presented !== undefined) {
      session = await findOwnSession(presented, owner);
      if (!session) return out(sessionNotFound(echoableId(messages, peek?.isBatch ?? false)));
    }

    if (c.req.method === 'DELETE') {
      // Without a session there is nothing to end: the SDK's stateless answer (405).
      if (!session) return out(await handler.fetch(c.req.raw));
      await endSession(session, systemClock);
      return out(new Response(null, { status: 200 }));
    }

    if (session) {
      try {
        await touchSession(session, { headers: c.req.raw.headers, messages }, systemClock);
      } catch (e) {
        console.warn(`mcp: session bookkeeping failed: ${errorTag(e)}`);
      }
    }

    const res = await handler.fetch(c.req.raw, {
      authInfo: {
        ...result,
        extra: {
          ...result.extra,
          // Exactly one of the two (server.ts callContextFrom insists).
          upstream,
          unified: slug === null,
          wantsInstructions,
          session: session ? { id: session.id, createdAt: session.createdAt.toISOString() } : null,
          // Per-call diagnostics for the audit row (names only, clipped).
          diagnostics: requestDiagnostics(c.req.raw.headers, messages),
        },
      },
    });

    if (init && res.ok) {
      try {
        const created = await createSession(owner, init, c.req.raw.headers, systemClock);
        return out(withSessionHeader(res, created.id));
      } catch (e) {
        // No session is not an error: the client simply stays sessionless.
        console.warn(`mcp: session not created: ${errorTag(e)}`);
      }
    }
    return out(res);
  }

  // All of the caller's upstreams in one (ADR-0017).
  app.all('/mcp', (c) => serve(c, null));

  app.all('/mcp/:slug', async (c) => {
    const slug = c.req.param('slug');
    // register/token are the OAuth endpoints (a wrong method on them lands here);
    // anything else that is not a valid slug cannot exist. Neither reveals
    // anything, so no auth is needed to say 404.
    if (!isUpstreamSlug(slug)) return c.json(NOT_FOUND, 404);
    return serve(c, slug);
  });

  // Anything deeper under /mcp (e.g. /mcp/foo/bar) is not an endpoint either;
  // without this the SPA fallback would answer a GET with index.html.
  app.all('/mcp/*', (c) => c.json(NOT_FOUND, 404));

  console.log('MCP mounted at /mcp and /mcp/<slug>.');
}
