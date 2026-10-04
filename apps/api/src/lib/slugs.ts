// Upstream slugs: the path segment in /mcp/<slug> (ADR-0014) and the tool
// prefix in the aggregated endpoint. One definition for the REST validation
// (routes/upstreams.ts) and the MCP routes (mcp/*), so they cannot drift.

/** Path segments under /mcp that are the OAuth endpoints (mcp/oauthRoutes.ts),
 * never an upstream. */
export const RESERVED_SLUGS = ['register', 'token'];

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isUpstreamSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && !RESERVED_SLUGS.includes(value);
}
