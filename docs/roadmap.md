# Roadmap

> **What's still open.** This file only holds work that is *not done*. Shipped
> entries move to `roadmap-archive.md` (create it with the first one) rather than
> being ticked off here. Ideas that aren't scheduled live in `ideas.md`; the
> reasoning behind decisions lives in `decisions/`.

_Last updated: 2026-10-04 (briefing reviewed with Matthias; scaffold deployed
behind Authelia, `edge` image)_

## Open: discuss with Matthias

1. **How upstreams appear to Claude** (grouping, scope, approval level in the
   tool description): one connector per upstream vs one aggregated endpoint.
   Lead's recommendation pending his answer; becomes ADR-0014.

## Next — milestone 1: Claude.ai → xitl → Haushalt, approval on the phone

Slices (lead's plan; each verifiable on its own, app working in between):

1. **Data model + upstream registry:** `Upstream` (name, URL, description),
   per-user `UpstreamConnection` (tokens), `Policy`/overrides, `Snooze`,
   `AuditEntry`, all user-scoped (ADR-0010). Settings UI to add an upstream.
2. **Upstream OAuth client** (ADR-0013): connect flow from the UI, token
   storage and refresh, "reconnect" state. Tested against a Haushalt built
   locally (its e2e server pattern) rather than production.
3. **Inbound MCP OAuth** copied from Haushalt (ADR-0012): DCR, consent behind
   Authelia, user-bound tokens, client list in Settings.
4. **Proxy core:** `tools/list` and `tools/call` pass-through per ADR-0014,
   annotations read, unknown tools flagged.
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

- Rezepte as second upstream; Authelia access for Tina to Rezepte (Matthias).
- Tina onboarded with her own connections.
- More upstreams as they come.

## Still to define

- **Manual test gates** (`testing.md`): real Claude.ai connection, consent
  flows in both directions, push to a real phone, real approval latency vs 5 min.
