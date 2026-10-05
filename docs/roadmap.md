# Roadmap

> **What's still open.** This file only holds work that is *not done*. Shipped
> entries move to `roadmap-archive.md` (create it with the first one) rather than
> being ticked off here. Ideas that aren't scheduled live in `ideas.md`; the
> reasoning behind decisions lives in `decisions/`.

_Last updated: 2026-10-05 (failing upstream visible on `/mcp`, ADR-0022; unreleased)_

## Next

1. **LLM proposes policy, user confirms in the app** (ideas.md): design + ADR
   first, then Matthias decides.
2. MG-05 (Tina), whenever convenient.

## Milestone 1 status

Deployed (`v0.4.1` is the latest release) and in daily use: Matthias's
Claude.ai uses the unified `/mcp` connector (Haushalt, Rezepte, Einkaufsliste
behind it) from 2026-10-05 on. Manual gates MG-01…04, MG-06 and MG-07 passed
(`testing.md` run log). **Open:**

- **MG-05:** Tina's own consent and Haushalt connection, no cross-user
  visibility. Needs Tina.

**Production rules (still binding):** never set `APPROVAL_TIMEOUT_MS` or
`PUSH_OUTBOX`; the ingress must not buffer `/api/approvals/stream` (SSE) and
must allow responses up to 300 s on `/mcp/*`; `/oauth/authorize` and `/api/*`
stay behind Authelia.

## Debt and open points (from slice 1+3 review, 2026-10-04)

- **Dev server proxies only `/api`:** `/mcp`, `/oauth`, `/.well-known` are
  reachable on :3002 only, not via the Coder URL, so Claude.ai can't be tested
  against the workspace. Add Vite proxy entries if that's wanted.
- Revoked/flood calls send no "resolved" push; a stale notification answers
  "Nicht mehr offen" when tapped.
- Approval stream cap (`MAX_APPROVAL_STREAMS_PER_USER` = 5 per user) counts
  open SSE connections, not devices: every tab takes a slot, and a half-dead
  connection holds its slot until the server notices the abort. In-memory,
  which is exact with the single replica.
- **Grouping (ADR-0019, built):** time gaps per client (10 min); two chats in
  parallel on one connector share a group.
- **READONLY pause trusts `readOnlyHint`** as declared when the tool was first
  seen/acknowledged (ADR-0019 consequence).
- **Sessions:** no TTL/cleanup (one row per `initialize`); unknown session id →
  404 per spec — if MG-06 shows Claude.ai breaking on 404, serve unknown ids
  sessionless instead (deliberate deviation); 2026-07-28-era clients have no
  sessions at all (grouping falls back to time gaps for them).
- **e2e ordering trap:** TC-16 assumes `anna` has no connected upstream; specs
  that connect one for her must use another user.
- **Decided 2026-10-04 (Matthias), no change:** lock-screen "Erlauben" stays
  for all tools, destructive ones included (summary is agent-controlled;
  accepted).
- `inputSchema` changes aren't detected (not stored).
- Boot sweep labels an ALLOW call that crashed mid-forward `DENIED +restart`,
  though it may have reached the upstream.
- **Unified `/mcp`:** `tools/list` fans out to every usable upstream per call
  (no cache, ideas.md); a failing upstream is left out but named by the
  `xitl-status` placeholder (ADR-0022); no `list_changed` there either.
- **Failure state (ADR-0022):** `lastFailureAt` lags: a recovered upstream
  stays "nicht erreichbar" until its next contact; a row can hold a stale
  `lastFailureAt` next to `NEEDS_RECONNECT` (reconnect wins in UI/agent text,
  cleared by the first successful contact after reconnecting). A tool call
  timing out (120 s) counts as a failure.
- Only `tools` are proxied (no resources/prompts); no `list_changed`
  notifications (stateless endpoint; next `tools/list` sees changes).
- DCR cleanup (TC-88): prune-then-create isn't atomic, so concurrent
  registrations can briefly exceed `MAX_UNBOUND_CLIENTS` by a few; the next
  registration (or boot) corrects it. Registration spam can evict a client
  that is mid-consent (it fails closed: "Unbekannter … client_id", register
  again).
- Signed auth codes are replayable within 60 s (needs PKCE verifier too),
  copied caveat from Haushalt.
