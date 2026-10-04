# 0008. One complete audit record per call, unredacted in v1

- **Status:** Accepted (2026-10-04), per user (ADR-0010)
- **Date:** 2026-10-04

## Decision

Every `tools/call` that reaches the proxy produces one audit record: caller,
upstream, tool, **full payload**, the **decision path** (which rule, or snooze,
or timeout), reviewer **reasoning and confidence** if a reviewer agent was
involved, the **intent summary** if one was made, the **outcome** and the
upstream result status. Stored in SQLite.

**No field redaction in v1**, on purpose: one admin, own disk.

## Consequences

- The DB will contain whatever agents sent upstream, secrets included if an
  agent pastes one. Redaction/encryption is parked in `ideas.md` with its
  triggers (second reviewer, weaker disk guarantees, secrets-manager upstream).
