# Roadmap

> **What's still open.** This file only holds work that is *not done*. Shipped
> entries move to `roadmap-archive.md` (create it with the first one) rather than
> being ticked off here. Ideas that aren't scheduled live in `ideas.md`; the
> reasoning behind decisions lives in `decisions/`.

_Last updated: 2026-10-04 (briefing reviewed with Matthias; scaffold deployed
behind Authelia, `edge` image)_

## Next — milestone 1: Claude.ai → xitl → Haushalt, approval on the phone

Slices (lead's plan; each verifiable on its own, app working in between;
numbers are stable, done ones moved to `roadmap-archive.md`):

8. **Malicious-client suite**, first cases: cross-user access, forged tokens,
   upstream token leakage, approval of another user's call.

Slices 1–7 are done. Remaining: slice 8, then a release (Matthias's call) and
the manual gates MG-01…05 (`testing.md`).

**Deploy checklist (GitOps, Matthias):** `MCP_TOKEN` secret ✅ (2026-10-04);
Authelia exemptions for `/mcp*` ✅ — confirm `/.well-known/*` too, and that
`/oauth/authorize` + `/api/*` stay behind Authelia; `PUBLIC_URL=https://<xitl>`
(OAuth redirect and VAPID subject); egress 443 to the siblings' public URLs and
to `fcm.googleapis.com`; ingress must not buffer `/api/approvals/stream` (SSE)
and must allow responses up to 300 s on `/mcp/*`. Never set
`APPROVAL_TIMEOUT_MS` or `PUSH_OUTBOX` in production.

## After milestone 1

- Rezepte as second upstream, plus the aggregated `/mcp` endpoint (ADR-0014); Authelia access for Tina to Rezepte (Matthias).
- Tina onboarded with her own connections.
- More upstreams as they come.

## Debt and open points (from slice 1+3 review, 2026-10-04)

- **SSRF:** upstream URLs accept any http(s) address (internal IPs, cluster
  services). Needs an outbound address policy before the proxy fetches
  anything; must still allow the sibling apps.
- **DCR is open** (`/mcp/register`, as in Haushalt): unbound clients pile up if
  spammed. Cleanup of never-approved clients after a day would do.
- **Dev server proxies only `/api`:** `/mcp`, `/oauth`, `/.well-known` are
  reachable on :3002 only, not via the Coder URL, so Claude.ai can't be tested
  against the workspace. Add Vite proxy entries if that's wanted.
- **Rug pull vs explicit ALLOW** (question to Matthias): a changed tool with an
  explicit tool/client ALLOW is still forwarded. Recommendation: drop to ASK
  until acknowledged. Also: `inputSchema` changes aren't detected (not stored).
- **Lock-screen "Erlauben" decides on an agent-controlled 120-char summary**
  (question to Matthias): consider no approve action for destructive tools.
- **No caps** on held calls per user or SSE streams per user.
- Boot sweep labels an ALLOW call that crashed mid-forward `DENIED +restart`,
  though it may have reached the upstream.
- **SSRF via discovery:** OAuth discovery follows the upstream's metadata URLs
  from inside the cluster; responses aren't shown, but internal hosts can be
  probed. Covered by the outbound address policy above.
- URL change keeps tool policies by tool name (acknowledgements reset).
- Only `tools` are proxied (no resources/prompts); no `list_changed`
  notifications (stateless endpoint; next `tools/list` sees changes).
- KnownTool sync has no cap on tool count.
- Signed auth codes are replayable within 60 s (needs PKCE verifier too),
  copied caveat from Haushalt.

## Still to define

- **Manual test gates** (`testing.md`): real Claude.ai connection, consent
  flows in both directions, push to a real phone, real approval latency vs 5 min.
