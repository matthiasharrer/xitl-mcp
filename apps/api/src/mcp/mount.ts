// Mounts the MCP endpoints (ADR-0012, ADR-0014); copied from haushalts-todos'
// mcp/mount.ts and adapted to `/mcp/<slug>`. The one deliberate exception to "no
// login code in the app": Authelia's ForwardAuth covers every other route at the
// ingress; `/mcp*` is carved out of that so an MCP client can reach it without
// an Authelia session, which means the gate below is the *only* thing standing
// between this route and the open internet. Get it right, fail closed.
//
// Two bearer shapes (ADR-0015): `xitl_…` is a per-upstream access token, checked
// ONLY against its hash and the slug in the URL (verifier.ts, makeGateVerifier);
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
// `/mcp` (all upstreams in one) does not exist yet: 404.
//
// Sessions (ADR-0016, sessions.ts): a 2025-era `initialize` gets an
// `Mcp-Session-Id` (a DB row, no transport or server kept in memory); a later
// request carrying it must match user + client + upstream and not be ended, or
// it gets the SDK's 404 "Session not found"; `DELETE` with it ends the
// session. Requests without the header are served sessionless, as always.
import type { Hono } from 'hono';
import type { AppEnv } from '../identity.js';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/server';
import { buildMcpServer } from './server.js';
import { makeGateVerifier, makeVerifier } from './verifier.js';
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
 * refuses anything above MAX_MCP_BODY_BYTES before we get here anyway). */
const PEEK_MAX_BYTES = MAX_MCP_BODY_BYTES;

interface Peek {
  messages: Record<string, unknown>[];
  isBatch: boolean;
}

/** Parses a POST body from a clone (the handler reads the original). A hint
 * for instructions and session bookkeeping only: never decides who may do
 * what. null when not peekable (no declared length, too large, not JSON). */
async function peekBody(req: Request): Promise<Peek | null> {
  if (req.method !== 'POST') return null;
  // No declared length (chunked): don't buffer an unknown amount; the stored
  // instructions are used instead, and the session is not touched by the body.
  const declared = req.headers.get('content-length');
  const length = declared === null ? NaN : Number(declared);
  if (!Number.isFinite(length) || length > PEEK_MAX_BYTES) return null;
  try {
    const body = (await req.clone().json()) as unknown;
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
    const gate = requireBearerAuth({ verifier: makeGateVerifier(oauthVerifier, slug), requiredScopes: ['mcp'], resourceMetadataUrl });

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

    const mcpClientId = result.extra?.mcpClientId;
    if (typeof mcpClientId !== 'number') return c.json(NOT_FOUND, 404); // cannot happen after the verifier; fail closed
    const owner = { userId, mcpClientId, upstreamId: upstream.id };

    // Peek at the JSON-RPC body (on a clone; the handler reads the original)
    // so the server factory only contacts the upstream for its instructions
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
      if (!session) return sessionNotFound(echoableId(messages, peek?.isBatch ?? false));
    }

    if (c.req.method === 'DELETE') {
      // Without a session there is nothing to end: the SDK's stateless answer (405).
      if (!session) return handler.fetch(c.req.raw);
      await endSession(session, systemClock);
      return new Response(null, { status: 200 });
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
          upstream,
          wantsInstructions,
          session: session ? { id: session.id, createdAt: session.createdAt.toISOString() } : null,
        },
      },
    });

    if (init && res.ok) {
      try {
        const created = await createSession(owner, init, c.req.raw.headers, systemClock);
        return withSessionHeader(res, created.id);
      } catch (e) {
        // No session is not an error: the client simply stays sessionless.
        console.warn(`mcp: session not created: ${errorTag(e)}`);
      }
    }
    return res;
  });

  // Anything deeper under /mcp (e.g. /mcp/foo/bar) is not an endpoint either;
  // without this the SPA fallback would answer a GET with index.html.
  app.all('/mcp/*', (c) => c.json(NOT_FOUND, 404));

  console.log('MCP mounted at /mcp/<slug>.');
}
