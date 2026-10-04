// Copied from haushalts-todos. Every absolute URL this app hands out — the MCP
// OAuth layer's issuer/endpoints, the `resource_metadata` pointer and the
// per-upstream resource URLs (ADR-0012, ADR-0014) — has to agree on what "this
// server's public origin" is, or a client that's told one origin on one call
// and a different one on the next breaks. This is the one place that origin is
// derived, so there is exactly one answer.
import type { Context } from 'hono';

/** The external origin (scheme + host, no path) this request should be
 * described as arriving at, in priority order:
 *
 * 1. `PUBLIC_URL` (or its older name, `MCP_PUBLIC_URL`, kept so an existing
 *    deployment's env var keeps working untouched) — an explicit operator
 *    override for when the ingress doesn't (or can't) send forwarding
 *    headers, or the deployed origin differs from what they'd say.
 * 2. `X-Forwarded-Proto` + `X-Forwarded-Host` — what the ingress actually
 *    forwards (Authelia/ingress in front of this
 *    container). A proxy may send a comma-separated list for either header
 *    when there are multiple hops; the first value is the one the original
 *    client saw.
 * 3. `new URL(c.req.url).origin` — the fallback for local dev/e2e, where
 *    there is no proxy and the request's own URL already says the right
 *    thing (`http://127.0.0.1:<port>`).
 *
 * Never trailing-slashed. */
export function externalOrigin(c: Context): string {
  const override = process.env.PUBLIC_URL ?? process.env.MCP_PUBLIC_URL;
  if (override) return override.replace(/\/+$/, '');

  const proto = firstForwardedValue(c.req.header('X-Forwarded-Proto'));
  const host = firstForwardedValue(c.req.header('X-Forwarded-Host'));
  if (proto && host) return `${proto}://${host}`;

  return new URL(c.req.url).origin;
}

function firstForwardedValue(header: string | undefined): string | undefined {
  const value = header?.split(',')[0]?.trim();
  return value ? value : undefined;
}
