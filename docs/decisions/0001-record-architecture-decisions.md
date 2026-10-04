# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

This is a long-running project built across many sessions, mostly by AI agents
with Matthias as product owner, the same way as `rezepte` and `haushalts-todos`. Decisions made early
are easy to forget, and working out again "why did we do it this way?" wastes
time and risks reversing a decision by accident.

## Decision

Keep lightweight ADRs in `docs/decisions/`, one Markdown file per significant
decision, using `0000-template.md`. Decisions are append-only: to change one,
write a new ADR that supersedes it.

## Consequences

- The reasoning stays discoverable; `architecture.md` stays about the *current*
  state.
- Small discipline cost: write the ADR when the decision is made.

## Alternatives considered

- **Git history only** shows *what* changed, rarely *why*.
