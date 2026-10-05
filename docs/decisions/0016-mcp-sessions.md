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
