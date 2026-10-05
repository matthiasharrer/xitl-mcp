// Abuse limits (TC-44, TC-45, TC-48), in one place.
// A calling agent is untrusted: without a cap it could hold an unbounded
// number of calls (memory, a push per call, a flood of cards on the phone)
// or open unbounded approval streams. Plain counts, no time involved; the hub
// and the routes take overrides so unit tests can use small numbers.

/** Held (ASK) calls per user at a time. The next one is denied at once
 * (path `<rule>+flood`), audited, and pushes nothing. */
export const MAX_HELD_CALLS_PER_USER = 10;

/** Open `GET /api/approvals/stream` connections per user; the next one is 429. */
export const MAX_APPROVAL_STREAMS_PER_USER = 5;

/** Request bodies on the MCP / OAuth endpoints (`/mcp/*`, `/oauth/*`). */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** JSON bodies under `/api/*` (the largest legitimate one is an upstream with a
 * 4000-char header value). */
export const MAX_API_BODY_BYTES = 64 * 1024;

/** Bytes of ONE upstream HTTP response (MCP traffic: tools/list, tool results,
 * SSE streams). Larger -> the request fails (TC-48). */
export const MAX_UPSTREAM_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Bytes of one OAuth response from an upstream's AS (metadata, DCR, tokens). */
export const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;

/** Tools taken from one upstream tools/list; the rest are dropped with a log
 * line (never recorded, never listed, so a call to one is "unknown-tool"). */
export const MAX_UPSTREAM_TOOLS = 500;

/** KnownTool rows kept per upstream (tools that dropped out of the list stay
 * as rows). Past this, rows NOT in the current list are deleted after a sync,
 * oldest `lastSeenAt` first; rows in the current list never are. A deleted
 * tool that comes back is "Neu" again (fails closed). */
export const MAX_KNOWN_TOOLS_PER_UPSTREAM = 1000;

/** OAuth clients from DCR (`/mcp/register`, public) that nobody approved on
 * the consent page (userId null) are deleted after this long. */
export const UNBOUND_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Unbound OAuth clients kept at most; a new registration evicts the oldest
 * unbound ones first. Bound and TOKEN clients never count and are never
 * touched. */
export const MAX_UNBOUND_CLIENTS = 100;
