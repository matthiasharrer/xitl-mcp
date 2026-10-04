# 0010. Two separate users from Authelia; nothing shared

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The briefing assumed one admin and one reviewer with a hardcoded admin
credential. Matthias wants his wife (Tina) to use xitl too, from her own Claude
and other clients.

## Decision

- **Users come from Authelia** (`Remote-User` → `User` row), as in the siblings.
  No password or admin hash in the app.
- **Completely separate accounts, nothing shared** in the first phase: each
  user has their own OAuth clients (consented under their identity), upstream
  connections, policies, pending approvals, push subscriptions and audit.
- Every user-owned row carries `userId`; every query is scoped by it. Cross-user
  access is a security bug, and the malicious-client suite gets cases for it.

## Consequences

- Policies are per user. Whether there are shared policy *templates* is open.
- **Upstreams that are themselves per-user (Haushalt, Rezepte) need a per-user
  connection**, see roadmap ("upstream OAuth").
- Who may change global settings (e.g. trust tier definitions) is open; default
  is per-user unless decided otherwise.

## Alternatives considered

- **One admin + reviewer (briefing).** Doesn't fit two people using it.
- **Shared household account.** Matthias explicitly wants them separate.
