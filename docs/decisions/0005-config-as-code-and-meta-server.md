# 0005. Config as code; the meta server can draft but never apply

- **Status:** Rejected 2026-10-04: two users editing from phones need policies in the app, see [ADR-0011](0011-policies-in-the-app.md)
- **Date:** 2026-10-04

## Context

Policies need to be reviewable and versionable, and writing them with an LLM's
help is attractive. But an agent that can change the policy guarding it has
defeated the proxy.

## Decision

- **One YAML file per upstream**, with per-tool entries and per-caller
  overrides. Upstream credentials are **not** in these files (ADR-0007).
- A **meta MCP server** in three tiers:
  1. **Discovery:** read-only (upstreams, tools, current policy, credentials
     masked).
  2. **Draft/propose:** writes draft files only; never a live effect.
  3. **`apply_draft`:** **CLI only, run by the human.** Not exposed as an MCP
     tool to any agent, ever.
- Drafts are plain files. Diffs come from the npm package `diff`. A draft
  records the SHA-256 of the file it was based on (`base_version`); applying a
  draft whose base is stale is refused. No git dependency.
- Tool names and descriptions must not suggest a live effect ("propose…",
  "draft…", never "set…" / "update…").

## Consequences

- The human is the only path from draft to live, enforced by *absence* of an
  MCP tool, not by a permission check that could be misconfigured.
- Applying needs a shell in the container (`kubectl exec`). Acceptable for one
  admin; a UI apply button would be a new decision.

## Alternatives considered

- **Policies in the database, edited in the UI.** Loses diffability and makes
  "an LLM drafts, a human applies" harder to keep honest.
- **Git as the draft store.** An extra moving part for one admin.
