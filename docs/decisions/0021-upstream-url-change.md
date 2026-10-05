# 0021. A URL change of an upstream resets trust

- **Status:** Accepted (Matthias, 2026-10-05)
- **Date:** 2026-10-05

## Context

An upstream's URL can be edited (`PATCH /api/upstreams/:id`). Until `v0.4.0`
a URL change dropped OAuth tokens and ended held calls, but otherwise kept
nearly everything the user had decided for the *old* server:

- KnownTool rows only lost `acknowledgedAt` (shown as "Neu"). The policy
  engine (ADR-0004, `lib/policy.ts`) lets an explicit tool-level or
  client-level ALLOW win over "new", so those rules kept applying by tool
  name to whatever the new server calls `add_item`.
- Snoozes (pauses of every scope) kept applying.
- A HEADER upstream's stored secret was sent to the new URL.

The change is user-initiated, but a silent re-point (a typo, a moved
service, someone editing in a hurry) must not carry old permissions or a
secret to a server the user never reviewed. Fail closed (ADR-0003 threat
model).

## Decision

When a PATCH really changes the URL (`url !== stored url`):

- **Every KnownTool** of the upstream gets `changedAt = now` (Clock) and
  `acknowledgedAt = null`: the UI says "Geändert", and the existing engine
  turns an explicit tool or client ALLOW into ASK `changed-tool` until the
  user acknowledges the tool or sets its policy (which clears `changedAt`).
  Explicit ASK/DENY still apply. **The policies themselves are kept**
  (tool policy and ClientToolPolicy rows).
- **Every Snooze** of the upstream is deleted, all scopes (TOOL, READONLY,
  UPSTREAM). Other upstreams are untouched.
- **HEADER secret:** if the resulting auth is HEADER, the request must carry
  a non-empty `headerValue`, else 400 `{ error: 'Neue Adresse: Bitte gib den
  Header-Wert neu ein.', code: 'header_value_required' }` and nothing
  changes. This also covers switching to HEADER together with a URL change.
  A PATCH without a URL change keeps the stored value (write-only field).
- The row update, the tool reset and the snooze delete run in one
  `prisma.$transaction`, each scoped to the user. Held calls end `+revoked`
  as before; OAuth tokens and registration are dropped as before.
- Web: editing a HEADER upstream with a different URL makes the header value
  field required with the hint "Neue Adresse: Header-Wert bitte neu
  eingeben."; Save stays disabled until it is filled.

## Consequences

- After re-pointing, every call to that upstream asks until the user has
  looked at each tool in "Regeln" (acknowledge, or set a policy). Under an
  upstream default of ALLOW that is a burst of questions; intended.
- The user re-enters a HEADER secret even when the new address is the same
  service under a new name. Cheap, and the only way to know the secret is
  meant for the new address.
- A URL change that only normalises the string (e.g. a trailing slash)
  counts as a change. Accepted: comparing URLs semantically is a trap.
- Tested by TC-85…87.

## Alternatives considered

- **Delete the policies on a URL change.** Rejected: loses the user's work
  (per-tool and per-client rules can be many), and `changed-tool` already
  forces a review before any ALLOW applies again.
- **Keep everything as is** (only acknowledgements reset). Rejected: explicit
  ALLOW rules, pauses and the header secret silently carry over to a server
  nobody reviewed.
