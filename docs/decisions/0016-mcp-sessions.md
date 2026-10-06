# 0016. MCP sessions for grouping calls, measured before designing around them

- **Status:** Accepted (step 1: sessions + measurement); grouping UI decided after MG-06
- **Date:** 2026-10-05

## Context

Matthias wants calls grouped "by session, ideally per Claude chat". The
endpoint is stateless so far (copied from Haushalt), so clients get no
`Mcp-Session-Id`. Whether Claude.ai opens one MCP session per chat is unknown;
it sends no chat id that we know of.

## Decision

- `/mcp/<slug>` issues an `Mcp-Session-Id` on `initialize` and stores the
  session (user, client, upstream, clientInfo, protocol version, User-Agent,
  start/last seen/end). Request handling otherwise stays per request.
- Session ids are **not credentials**: the bearer token still decides who acts.
  A session id that isn't the caller's (user + client + upstream), ended or
  unknown → 404, so the client re-initializes (spec behaviour). Stored in the DB,
  so restarts don't break sessions.
- Audit rows and held approvals carry the session; the UI shows it.
- **Measurement first:** per session, header names and `_meta` keys seen are
  recorded (names only) so a real Claude.ai / Claude Code run (MG-06) shows what
  identifies a chat.
- After MG-06: if sessions match chats, Freigaben/Verlauf group per session;
  otherwise group per client by time gaps (~10 min). Separate ADR then.

## Consequences

- Clients that don't do sessions are unaffected.
- A later option: snooze "für diese Sitzung".

## Alternatives considered

- **Group by time gaps only.** Works for every client but is a guess; kept as
  the fallback.

## Measurement result (2026-10-05, deployed `v0.3.1`, one Claude.ai call)

- Claude.ai speaks **2026-07-28**: no `initialize`, so **no sessions**, by
  design of that protocol revision. `_meta` carries only the standard
  envelope: `io.modelcontextprotocol/clientCapabilities`, `…/clientInfo`
  (`Anthropic/ClaudeAI 1.0.0`), `…/protocolVersion`. No chat id in `_meta`.
- User-Agent `Claude-User`. Headers (names): `accept`, `accept-encoding`,
  `authorization`, `content-length`, `content-type`, `host`, `mcp-method`,
  `mcp-name`, `mcp-protocol-version`, `traceparent`, `user-agent`,
  `x-anthropic-client`, `x-cloud-trace-context`, plus the ingress's
  `x-forwarded-*` / `x-real-ip`. The body arrived with `content-length`.
- Grouping candidates: the trace id of `traceparent` (W3C) and of
  `x-cloud-trace-context` (GCP), and the `x-anthropic-client` value. Since
  v0.3.2 these values are stored per call (trace part only). Next measurement:
  several calls in one chat, and in two chats — does a trace id stay the same
  per chat, per turn, or change per call? If none is stable per chat, the
  grouping falls back to time gaps per client.

## Measurement result 2 (2026-10-05, deployed `v0.3.2`, 8 calls)

Four headless Claude Code runs ("chats"), two `list_tasks` calls each:

- **Claude Code's own MCP client** (`claude mcp add`, all-upstreams token, `/mcp`):
  protocol 2026-07-28, clientInfo `claude-code 2.1.289`, UA
  `claude-code/2.1.289 (sdk-cli)`, **no** trace headers. `_meta`: the standard
  envelope + `claudecode/toolUseId` + `progressToken` (both per call). No
  session (2026 era).
- **claude.ai connector used from Claude Code** (`/mcp/<slug>`, requests come
  from Anthropic's backend): same protocol and clientInfo (forwarded), UA
  `Claude-User`, `x-anthropic-client: ClaudeCode`, `traceparent` and
  `x-cloud-trace-context` carry the same trace id — but a **different trace id
  on every call**, also between the two calls of one chat.
- **Conclusion:** neither path sends anything stable per chat. Trace ids,
  `toolUseId` and `progressToken` are per call. Grouping falls back to time
  gaps per client (decision with Matthias). The per-call diagnostics stay
  (cheap, and a future client may send a chat id).

## Measurement (2026-10-06, Matthias, Claude.ai web on `v0.6.0`)

Claude.ai **web** (`x-anthropic-client: ClaudeAI`, UA `Claude-User`,
protocol 2026-07-28, clientInfo `Anthropic/ClaudeAI 1.0.0`): `traceparent`
and `x-cloud-trace-context` carry the same trace id, and it is **the same for
all tool calls of one user message** (one assistant turn) and new for the next
message in the same chat. This differs from the 2026-10-05 measurement of the
claude.ai connector *used from Claude Code* (`x-anthropic-client:
ClaudeCode`), where it changed on every call. Single observation so far (one
chat, two messages); not yet checked with two chats in parallel.

So for Claude.ai web a trace id = one turn ("Nachricht"), not one chat. Uses
(ideas.md): sub-groups per message in Verlauf, separating parallel chats
whose turns overlap, and a "new user message" marker for the intent model.
Client-sent and unauthenticated: grouping/advisory only, never policy.

## Amendment (2026-10-05): sessions expire

Sessions had no end unless the client sent `DELETE`, which almost no client
does. One row was added per `initialize`, forever.

- A session not seen for **30 days** (`lastSeenAt`, which an ended session
  also carries) is deleted: `SESSION_TTL_MS` in `lib/limits.ts`.
- At most **500 sessions per user** (`MAX_SESSIONS_PER_USER`). Beyond that,
  the least recently seen are deleted first.
- Cleanup runs at boot (all users) and before every new session is created
  (that user only, leaving room for the new one). There is no timer.
- Audit rows stay. Their `sessionId` becomes null (existing `SetNull`), and
  Verlauf shows them without a session.
- A request presenting a deleted id gets the same 404 as an unknown one, and
  the client re-initializes. 30 days is far beyond any real client's idle
  time, so this only affects sessions that were abandoned anyway.
