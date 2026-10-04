# Roadmap

> **What's still open.** This file only holds work that is *not done*. Shipped
> entries move to `roadmap-archive.md` (create it with the first one) rather than
> being ticked off here. Ideas that aren't scheduled live in `ideas.md`; the
> reasoning behind decisions lives in `decisions/`.

_Last updated: 2026-10-04 (scaffold committed, nothing of the proxy built; first decisions taken)_

## Decided 2026-10-04

- Two separate users via Authelia, nothing shared (ADR-0010).
- Auto-deny after 300 s; timeout behaviour is a policy field (per upstream,
  per-tool override), v1 implements only `auto_deny` (ADR-0004).
- First real upstreams: **Haushalt and Rezepte**; both should move behind the
  proxy soon.

## Open: discuss with Matthias

1. **The briefing is a months-old summary.** ADRs 0003–0009 are marked
   Proposed until re-discussed.
2. **Upstream OAuth is now required, not an idea.** Haushalt and Rezepte accept
   only OAuth (no static bearer, both siblings' ADRs), with 1 h access tokens
   and 30-day refresh tokens. Haushalt binds tokens to the approving user. So
   xitl must be an **OAuth client per user per upstream** (connect flow, token
   refresh), otherwise the briefing's "paste a static credential" can't reach
   them. Recommendation: build it, scoped to the sibling apps' OAuth first.
3. **Rezepte is single-user by design.** Should Tina reach it through xitl at
   all? If yes, rezepte needs a user model first.
4. **Policy shape:** per upstream with per-tool overrides (Matthias). Per user,
   or shared templates?

## Next — Phase 1: proxy core + policy engine (ADR-0004, 0008)

Slicing (lead's plan, each slice verifiable on its own):

1. **Config loading:** YAML per upstream from `data/upstreams/`, validated with
   zod; `default_policy: always_allow` is a load error. Unit-tested.
2. **Policy engine:** pure function (call, classification, caller, snoozes,
   clock) → decision + decision path. Vitest, fake timers.
3. **Pass-through proxy:** `/mcp/<upstream>` speaks MCP to the client,
   forwards to one stdio and one HTTP upstream; `tools/list` passes through;
   credential injection. MCP test client in e2e.
4. **Pending-call map + SSE approval UI:** EventEmitter; approve/deny/snooze in
   the browser (phone viewport); 300 s auto-deny via Clock.
5. **Audit records** for every call, and a read-only audit list in the UI.
6. **Malicious-client suite**, first cases (ADR-0003).

Without OAuth, phase 1 is workspace-only (no ingress exemption yet).

## Later phases

- **Phase 2:** OAuth AS (DCR, PKCE, resource indicators, trust tiers): ADR-0007.
- **Phase 3:** meta server, discovery → drafts; `apply_draft` CLI: ADR-0005.
- **Phase 4:** Web Push with actions: ADR-0009.
- **Deploy:** Flux manifests in the GitOps repo (Matthias's side): Deployment
  (`strategy: Recreate`, single replica), PVC at `/data`, ingress with Authelia
  and the OAuth/MCP exemptions. Not useful before phase 2.

## Still to define

- **Manual test gates** (`testing.md`): real Claude.ai connection, the DCR
  flow, real push delivery, real latencies vs the 300 s limit.
- Prototype spec beyond this roadmap: decided per slice in its brief.
