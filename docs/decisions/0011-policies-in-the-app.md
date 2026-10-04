# 0011. Policies live in the database and are edited in the app

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The briefing had YAML files per upstream, an LLM-facing "meta server" that
could only draft, and `apply_draft` from the CLI (ADR-0005). That fits one
admin with a shell. With two separate users (ADR-0010), both on phones, a
policy change via `kubectl exec` doesn't work.

## Decision

- Policies (upstream default, tool/client overrides, snoozes) are **rows owned
  by a user**, edited in the app's UI (mobile-first, German).
- The UI is behind Authelia, so **only a human can change policy**: there is
  no MCP tool, ever, that changes policy. That keeps ADR-0005's core rule.
- No meta server in v1. "An LLM proposes a policy change, the user confirms in
  the app" is in `ideas.md`.

## Consequences

- No diffable config files; the audit records policy changes instead.
- Upstream credentials are not policy and never shown in the UI after entry.

## Alternatives considered

- **YAML + CLI (ADR-0005).** One admin only.
