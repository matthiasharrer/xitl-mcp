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

/** Characters of an earlier call's result excerpt in the prompt (ADR-0025
 * amendment). The audit's resultText is already capped at 2000; this cap is
 * applied again in prompt.ts. */
export const MAX_INTENT_RESULT_CHARS = 2000;

/** Characters of a tool description in the prompt. */
export const MAX_INTENT_DESCRIPTION_CHARS = 1500;

/** Characters of the stored/shown summary (intent + concerns). */
export const MAX_INTENT_SUMMARY_CHARS = 600;

/** Characters of the model's short title (TC-126); longer ones are cut. */
export const MAX_INTENT_TITLE_CHARS = 60;

/** Characters of the intent in the replacement push (ADR-0025). */
export const MAX_INTENT_PUSH_CHARS = 200;

/** Characters of the raw model answer kept on the audit row (replayed as the
 * assistant turn); a longer answer is FAILED, never truncated (the prefix
 * must stay byte-identical). */
export const MAX_INTENT_ANSWER_CHARS = 4000;

/** Tokens of the model's answer itself (the JSON). max_tokens of a request is
 * this plus the thinking budget. */
export const INTENT_ANSWER_MAX_TOKENS = 300;

/** INTENT_LLM_THINK_BUDGET: default thinking tokens (ADR-0025 amendment,
 * measured 2026-10-06: 128 gives the quality at ≤ 5 s) and the cap; 0 = off. */
export const INTENT_THINK_BUDGET_DEFAULT = 128;
export const INTENT_THINK_BUDGET_MAX = 1024;

/** One model request; then it is aborted and the call's summary FAILED. */
export const INTENT_REQUEST_TIMEOUT_MS = 60_000;

/** Bytes of one LLM HTTP response. */
export const MAX_INTENT_RESPONSE_BYTES = 256 * 1024;

// ---- AI check of allow pauses (ADR-0029) --------------------------------------
// The state sent to Clef holds agent-controlled arguments: capped per call and
// in total. The total also keeps one request inside one llama.cpp ubatch
// (the server runs --ubatch-size 4096 tokens; a bigger request is HTTP 500,
// which would hold the call as `snooze-ki-error`).

/** Calls forwarded under the pause since its anchor, newest N, oldest first. */
export const PAUSE_CHECK_MAX_SINCE = 8;

/** Characters of one call's JSON-encoded arguments in the state; longer ones
 * go in as a truncated string (`argumentsTruncated`, as in the intent prompt).
 * Smaller than MAX_INTENT_ARGS_CHARS: ten calls must fit one ubatch. */
export const MAX_PAUSE_CHECK_ARGS_CHARS = 1200;

/** Characters of the whole state; over it, the OLDEST "calls since" are left
 * out until it fits (anchor and new call always stay). ~3k tokens. */
export const MAX_PAUSE_CHECK_STATE_CHARS = 9000;

/** Characters of the anchor's intent summary in the state. */
export const MAX_PAUSE_CHECK_SUMMARY_CHARS = 600;

/** PAUSE_CHECK_TIMEOUT_MS: default and the accepted range. */
export const PAUSE_CHECK_TIMEOUT_DEFAULT_MS = 10_000;
export const PAUSE_CHECK_TIMEOUT_MAX_MS = 60_000;

/** PAUSE_CHECK_THRESHOLD default: p(gleich) at or above it forwards. */
export const PAUSE_CHECK_THRESHOLD_DEFAULT = 0.8;

/** Bytes of one Clef response. */
export const MAX_PAUSE_CHECK_RESPONSE_BYTES = 64 * 1024;

// ---- Review hint for new and changed tools (ADR-0031) -------------------------

/** Characters of a tool's canonical inputSchema JSON kept on KnownTool; over
 * it, this many chars plus `…#sha256:<hex>` of the whole (a change past the
 * cap still differs). */
export const MAX_TOOL_SCHEMA_CHARS = 16_000;

/** Characters of the description / parameter descriptions in a hint state. */
export const MAX_HINT_TEXT_CHARS = 3000;

/** A description counts as "grown a lot" past +50 % or +400 characters. */
export const HINT_GROWTH_RATIO = 1.5;
export const HINT_GROWTH_CHARS = 400;

/** p(injection) at or above it is an attention reason. */
export const HINT_INJECTION_THRESHOLD = 0.5;

// ---- AUTO policy (ADR-0030) ---------------------------------------------------

/** Upstream.autoRule: the prose rule, at most this many characters. */
export const MAX_AUTO_RULE_CHARS = 1000;

/** AUTO_THRESHOLD default: p(erlaubt) at or above it forwards. */
export const AUTO_THRESHOLD_DEFAULT = 0.8;

/** "Mit Verlauf testen": the user's newest N audit rows of the upstream. */
export const AUTO_TEST_MAX_ROWS = 50;

/** Characters of a tool description inside the AUTO call block. */
export const MAX_AUTO_DESCRIPTION_CHARS = 1500;

/** "Vorschlag": tools (and description chars each) sent to the draft model. */
export const AUTO_DRAFT_MAX_TOOLS = 60;
export const AUTO_DRAFT_DESCRIPTION_CHARS = 300;

/** ADR-0029 amendment: the purpose ("Wofür?") of a Zeitfreigabe. */
export const MAX_PAUSE_PURPOSE_CHARS = 200;
