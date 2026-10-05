// CORS for browser MCP clients (ADR-0023), used ONLY by mcp/mount.ts for
// `/mcp` and `/mcp/<slug>`. Nothing else in the app ever sends
// `Access-Control-*` (no global cors() middleware on purpose: `/api/*` and
// `/oauth/*` ride on Authelia cookies).
//
// - Preflight (OPTIONS + Origin, no token): 204 with the fixed headers below
//   when SOME token client lists the origin, else 403 without any CORS header.
//   A positive preflight grants nothing; the request itself is checked.
// - Requests: the verified TOKEN client must list the origin (mount.ts), and
//   its responses then carry ACAO / Vary / Expose-Headers (body streamed
//   through, SSE keeps streaming).
// - Never `Access-Control-Allow-Credentials`: /mcp is bearer-only.
import { prisma } from '../db.js';
import { normalizeOrigin, originListed } from '../lib/origins.js';

export const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Max-Age': '600',
} as const;

export const EXPOSE_HEADERS = 'Mcp-Session-Id, WWW-Authenticate';

/** Does ANY token client (of any user) list this request origin? Exact
 * comparison after normalization; the SQL `contains` only narrows the rows
 * (LIKE is case-insensitive and has wildcards, so it never decides). */
export async function originListedByAnyToken(requestOrigin: string | undefined): Promise<boolean> {
  const origin = normalizeOrigin(requestOrigin);
  if (origin === null) return false;
  const rows = await prisma.mcpClient.findMany({
    where: { kind: 'TOKEN', userId: { not: null }, allowedOrigins: { contains: JSON.stringify(origin) } },
    select: { allowedOrigins: true },
  });
  return rows.some((r) => originListed(origin, r.allowedOrigins));
}

/** The answer to `OPTIONS /mcp…` carrying an `Origin`. */
export async function preflight(requestOrigin: string): Promise<Response> {
  if (!(await originListedByAnyToken(requestOrigin))) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': normalizeOrigin(requestOrigin)!, Vary: 'Origin', ...PREFLIGHT_HEADERS },
  });
}

/** `res` with the CORS response headers for `origin` added (body passed
 * through unbuffered). `origin` must already be allowed by the caller. */
export function withCors(res: Response, origin: string): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  const vary = headers.get('Vary');
  if (!vary) headers.set('Vary', 'Origin');
  else if (!vary.split(',').some((v) => v.trim().toLowerCase() === 'origin')) headers.set('Vary', `${vary}, Origin`);
  headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
