# 0036. An optional reason when denying, passed to the agent

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

When Matthias declines a call, the agent only gets „[xitl] Abgelehnt: … hat
den Aufruf von „X“ abgelehnt“. It doesn't know why, so it often retries the
same tool, tries a sibling tool, or gives up when a small correction would do
(„falsches Tool“, „nicht nochmal versuchen“, „frag mich erst im Chat“).
Matthias asked for an optional reason (roadmap, 2026-10-07), and on
2026-10-16 he chose **quick chips plus free text** over an always-visible text
field.

## Decision

- **Card (Freigaben list and deep-link page):** above „Ablehnen / Erlauben“, a
  row „Grund fürs Ablehnen (optional)“ with toggle chips:
  - „Falsches Tool“
  - „Nicht nochmal versuchen“
  - „Erst im Chat nachfragen“
  - „Eigener Grund …“, which shows a one-line text field (≤ 120 characters).

  More than one chip can be on. Nothing selected and the field empty means no
  reason: **one tap on „Ablehnen“ stays one tap**, and the agent text is the
  same as before. While a reason is set, the deny buttons read „Ablehnen mit
  Grund“ (plain) and keep their Sperre labels. The reason applies to the
  plain „Ablehnen“ and to every „Ablehnen · … sperren“ button. It never
  applies to „Erlauben“.
- **The reason text** is the selected chips' labels in the order shown,
  followed by the free text, joined with „; “. The client builds it; the
  server validates it as an opaque string.
- **API:** `POST /api/approvals/:id` takes `reason?: string`, trimmed. It must
  be ≤ 200 characters and contain no control characters, and is only allowed
  with `decision: 'deny'`. Otherwise the server answers 400 and decides
  nothing (fail closed). An empty string after trimming means no reason.
- **Agent text:** `MSG.declined` and `MSG.blocked` get an optional reason:
  `… abgelehnt. Grund: „<reason>“ / Declined: … Reason: "<reason>"`. The
  German and English halves carry the same human text; it is not translated.
- **Audit:** a new column `AuditEntry.denyReason` holds the reason. It is part
  of `resultText` (what the agent got) anyway. The Verlauf list row's shape
  gains `denyReason`, and the detail shows it as „Grund: …“.
- **Only the tapped call carries the reason.** Held calls that a Sperre settles
  along with it (`via: 'pause'`) get the plain blocked text: the reason was
  given about one call, not about them.
- **Not on the lock-screen action** (the notification's „Ablehnen“): no text
  input there. The push route never sends a reason.

### Threat model

The reason is written by the human, through `/api` behind Authelia and the
`Sec-Fetch-Site` guard. It is **instruction to the agent by design**, which
is the point of the feature. Nothing the agent sends can set it: there is no
MCP path to it, and it is never derived from tool arguments, intent output
or upstream data. It decides nothing in the proxy; a reason never turns a deny
into anything else. The UI shows it as text (no `{@html}`).

## Consequences

- Fewer retry loops when the agent was simply on the wrong path.
- One more row of chips on an already long card. The chips are small and sit
  next to the button they modify.
- The fixed chip texts are product copy in the client. Changing them needs no
  migration, because the server stores the resulting string.

## Alternatives considered

- **Always-visible text field:** typing on the phone for every deny with a
  reason is slow, and it takes as much room as the chips. Matthias chose chips.
- **Reason as an enum on the server:** the chip set would be fixed in the API
  for no security gain, since the free text is arbitrary anyway.
- **Ask for the reason after denying** (undo-style toast): the agent already
  has its answer by then.
