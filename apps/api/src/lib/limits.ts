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
