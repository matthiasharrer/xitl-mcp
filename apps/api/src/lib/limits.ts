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

/** MCP sessions (ADR-0016 amendment) not seen for this long are deleted
 * (`lastSeenAt`, which an ended session carries too; exactly this old stays).
 * Their audit rows stay, with `sessionId` null. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Sessions kept per user at most; a new `initialize` evicts that user's
 * least recently seen ones first. Other users' sessions never count. */
export const MAX_SESSIONS_PER_USER = 500;

// ---- Intent summary (ADR-0025) -------------------------------------------------
// The model sees agent- and upstream-controlled text: every piece is capped.

/** Calls waiting for a summary (all users). Over it, the oldest entries that
 * are not held are marked SKIPPED (held calls go last). */
export const MAX_INTENT_QUEUE = 200;

/** Calls (model turns) in one append-only context; the next call starts a
 * fresh context (system prompt only). */
export const MAX_INTENT_CONTEXT_CALLS = 20;

/** Characters of one context (system prompt + every stored turn + answer +
 * the new turn); over it, the call starts a fresh context. ~16k tokens. */
export const MAX_INTENT_CONTEXT_CHARS = 48_000;

/** Characters of a call's JSON-encoded arguments in the prompt; longer ones
 * go in as a truncated string. */
export const MAX_INTENT_ARGS_CHARS = 4000;

/** Characters of a tool description in the prompt. */
export const MAX_INTENT_DESCRIPTION_CHARS = 1500;

/** Characters of the stored/shown summary (intent + concerns). */
export const MAX_INTENT_SUMMARY_CHARS = 600;

/** Characters of the intent in the replacement push (ADR-0025). */
export const MAX_INTENT_PUSH_CHARS = 200;

/** Characters of the raw model answer kept on the audit row (replayed as the
 * assistant turn); a longer answer is FAILED, never truncated (the prefix
 * must stay byte-identical). */
export const MAX_INTENT_ANSWER_CHARS = 4000;

/** One model request; then it is aborted and the call's summary FAILED. */
export const INTENT_REQUEST_TIMEOUT_MS = 60_000;

/** Bytes of one LLM HTTP response. */
export const MAX_INTENT_RESPONSE_BYTES = 256 * 1024;
