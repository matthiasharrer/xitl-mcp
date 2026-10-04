# 0009. Approval on the phone via Web Push with actions

- **Status:** Proposed — from a months-old summary of earlier discussions; Matthias wants to re-discuss before it binds (2026-10-04)
- **Date:** 2026-10-04

## Decision

- **Web Push (VAPID)** through a minimal **PWA with service worker**.
- **Approve / Deny buttons in the notification itself**, usable from the lock
  screen.
- The decision returns by an **authenticated HTTPS call**, not over MCP.
- Payload ≤ **4 KB**: call id plus a short summary.
- **Every pending call is pushed immediately, high priority.** No risk tiering,
  no escalation ladder.
- The PWA detects stale subscriptions and re-registers.

## Consequences

- Haushalt's ADR-0009 (VAPID keys in `AppSetting`, subscription table, the
  outbox in e2e) is the pattern to copy. New here: notification actions and the
  service worker making an authenticated POST. With Authelia in front, that POST
  rides the session cookie, so a lock-screen approval after the Authelia
  session expired will fail. Measure in phase 4; it's the main real-world risk.
- Phase 1 uses an SSE page instead, which assumes the human is already looking:
  a prototype compromise, not a validated answer.

## Alternatives considered

Pushover, FCM/APNs, Slack/Teams: parked in `ideas.md`.
