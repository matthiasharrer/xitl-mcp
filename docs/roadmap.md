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

2. **Upstream OAuth client** (ADR-0013): connect flow from the UI, token
   storage and refresh, "reconnect" state. Tested against a Haushalt built
   locally (its e2e server pattern) rather than production.
4. **Proxy core:** `/mcp/<slug>` (ADR-0014): `tools/list` with policy stamp,
   `tools/call` pass-through, annotations read, unknown tools flagged.
5. **Policy engine** (ADR-0004): pure function, Vitest + fake timers; policy UI
   (upstream default, per-tool override, per-client override).
6. **Approval:** pending map + approval page (phone) + Web Push with
   approve/deny actions, copied from Haushalt's push (ADR-0009); 5 min auto-deny;
   snooze.
7. **Audit** (ADR-0008) and its list in the UI.
8. **Malicious-client suite**, first cases: cross-user access, forged tokens,
   upstream token leakage, approval of another user's call.

Release to the cluster when 1–6 work end to end in the workspace; the ingress
then needs Haushalt's `/mcp` + `/.well-known` exemptions (GitOps, Matthias).

## After milestone 1

- Rezepte as second upstream, plus the aggregated `/mcp` endpoint (ADR-0014); Authelia access for Tina to Rezepte (Matthias).
- Tina onboarded with her own connections.
- More upstreams as they come.

## Debt and open points (from slice 1+3 review, 2026-10-04)

- **SSRF:** upstream URLs accept any http(s) address (internal IPs, cluster
  services). Needs an outbound address policy before the proxy fetches
  anything; must still allow the sibling apps.
- **Status for HEADER/NONE upstreams** reads "Nicht verbunden" although they
  need no connect step; fix with the connect flow (slice 2).
- **DCR is open** (`/mcp/register`, as in Haushalt): unbound clients pile up if
  spammed. Cleanup of never-approved clients after a day would do.
- **Dev server proxies only `/api`:** `/mcp`, `/oauth`, `/.well-known` are
  reachable on :3002 only, not via the Coder URL, so Claude.ai can't be tested
  against the workspace. Add Vite proxy entries if that's wanted.
- Signed auth codes are replayable within 60 s (needs PKCE verifier too),
  copied caveat from Haushalt.

## Still to define

- **Manual test gates** (`testing.md`): real Claude.ai connection, consent
  flows in both directions, push to a real phone, real approval latency vs 5 min.
