# Roadmap

> **What's still open.** This file only holds work that is *not done*. Shipped
> entries move to `roadmap-archive.md` (create it with the first one) rather than
> being ticked off here. Ideas that aren't scheduled live in `ideas.md`; the
> reasoning behind decisions lives in `decisions/`.

_Last updated: 2026-10-04 (scaffold committed, nothing of the proxy built)_

## Decisions waiting for Matthias

1. **Consent-screen identity (ADR-0007):** hardcoded admin hash (briefing) vs
   Authelia `Remote-User` (sibling scheme). Recommendation: Authelia. Needed
   before phase 2, not before phase 1.
2. **Auto-deny vs queue/resume:** the timeout document and the design document
   disagree; ADR-0004 follows the design doc (auto-deny). Confirm.
3. **First real upstream for phase 1**, so the proxy is proven against something
   real: e.g. a filesystem server (stdio) or one of the sibling apps' `/mcp`
   (HTTP). Affects what goes into the image (ADR-0002).

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
