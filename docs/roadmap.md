# Roadmap

> **What's still open.** This file only holds work that is *not done*. Shipped
> entries move to `roadmap-archive.md` (create it with the first one) rather than
> being ticked off here. Ideas that aren't scheduled live in `ideas.md`; the
> reasoning behind decisions lives in `decisions/`.

_Last updated: 2026-10-05 (`v0.3.2`: trace ids per call, version footer)_

## Next

Nothing scheduled; Matthias picks. Candidates: deploy + manual gates
(MG-01…07), the SSRF outbound address policy, the URL-change question below.

## Milestone 1 status

`v0.3.1` (2026-10-05) fixes sessions behind the HTTP/2 ingress and adds per-call diagnostics (MG-06 reads them per call). `v0.3.0` adds the unified `/mcp` and token scopes (MG-07). `v0.2.0` contains slices 1–8, the changed-tool rule, per-upstream
access tokens (ADR-0015) and MCP sessions (ADR-0016). Waiting on Matthias:
deploy and manual gates **MG-01…06** (`testing.md`); MG-06 decides call
grouping (sessions vs time gaps, ADR-0016).

**Deploy checklist (GitOps, Matthias):** `MCP_TOKEN` secret ✅; Authelia
exemptions for `/mcp*` ✅ — confirm `/.well-known/*` too, and that
`/oauth/authorize` + `/api/*` stay behind Authelia; `PUBLIC_URL=https://<xitl>`
(OAuth redirect and VAPID subject); egress 443 to the siblings' public URLs and
to `fcm.googleapis.com`; ingress must not buffer `/api/approvals/stream` (SSE)
and must allow responses up to 300 s on `/mcp/*`. Never set
`APPROVAL_TIMEOUT_MS` or `PUSH_OUTBOX` in production.

## Debt and open points (from slice 1+3 review, 2026-10-04)

- **SSRF:** upstream URLs accept any http(s) address (internal IPs, cluster
  services). Needs an outbound address policy before the proxy fetches
  anything; must still allow the sibling apps.
- **DCR is open** (`/mcp/register`, as in Haushalt): unbound clients pile up if
  spammed. Cleanup of never-approved clients after a day would do.
- **Dev server proxies only `/api`:** `/mcp`, `/oauth`, `/.well-known` are
  reachable on :3002 only, not via the Coder URL, so Claude.ai can't be tested
  against the workspace. Add Vite proxy entries if that's wanted.
- **Question to Matthias: URL change of an upstream** keeps explicit tool/client
  ALLOW rules by tool name (only acknowledgements reset), and a HEADER
  upstream's static secret goes to the new URL. User-initiated, but a silent
  re-point keeps old permissions. Recommendation: a URL change marks all tools
  changed (→ ask until reviewed) and requires re-entering a HEADER secret.
- Revoked/flood calls send no "resolved" push; a stale notification answers
  "Nicht mehr offen" when tapped.
- Approval stream cap (5) counts connections per process, not devices.
- **Grouping (ADR-0016):** Claude.ai is 2026-07-28 (no sessions). Next
  measurement: trace ids per call across one chat and two chats; then decide
  trace-based vs time-gap grouping with Matthias.
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
- **No caps** on held calls per user or SSE streams per user.
- Boot sweep labels an ALLOW call that crashed mid-forward `DENIED +restart`,
  though it may have reached the upstream.
- **SSRF via discovery:** OAuth discovery follows the upstream's metadata URLs
  from inside the cluster; responses aren't shown, but internal hosts can be
  probed. Covered by the outbound address policy above.
- URL change keeps tool policies by tool name (acknowledgements reset).
- **Unified `/mcp`:** `tools/list` fans out to every usable upstream per call
  (no cache, ideas.md); a failing upstream silently drops its tools (only the
  log says why); no `list_changed` there either.
- Only `tools` are proxied (no resources/prompts); no `list_changed`
  notifications (stateless endpoint; next `tools/list` sees changes).
- KnownTool sync has no cap on tool count.
- Signed auth codes are replayable within 60 s (needs PKCE verifier too),
  copied caveat from Haushalt.

## Still to define

- **Manual test gates** (`testing.md`): real Claude.ai connection, consent
  flows in both directions, push to a real phone, real approval latency vs 5 min.
