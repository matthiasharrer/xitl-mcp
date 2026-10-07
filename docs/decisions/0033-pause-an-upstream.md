# 0033. An upstream can be paused: hidden from every client until resumed

- **Status:** Accepted (lead's defaults from Matthias's request, 2026-10-07; he may veto)
- **Date:** 2026-10-07

## Context

Some upstreams are only needed now and then. Matthias's example is n8n's
instance-level MCP: many tools that cost context in every chat. Today the
only way to take them out of the clients' view is to delete the upstream
(losing its rules) or to hide it per client (ADR-0032, one row per client).
An access can already be paused (ADR-0024); an upstream can't.

## Decision

1. **`Upstream.pausedAt`** (set from the Clock, null = active), set and
   cleared only through `/api` (Authelia), never through `/mcp`.
2. **A paused upstream is hidden from EVERY client,** the same way as
   ADR-0032's `client-hidden`:
   - no tools in `tools/list` on `/mcp` and `/mcp/<slug>`
   - no section and no state line in `/mcp`'s instructions; `/mcp/<slug>`
     initialize gets only xitl's line
   - **never contacted**: no tools/list, no tool sync, no instructions fetch,
     no token refresh, no ADR-0022 failure push or Freigaben notice
   - a call is refused with exactly the unknown-tool text for the name as
     called, audited DENIED `upstream-paused`, no gate, no hold, no intent
3. **Policy:** `evaluatePolicy` gets a required `upstreamPaused: boolean`,
   checked right after `unknown-tool` and before `client-hidden`. Anything but
   `false` counts as paused (fail closed).
4. **Pausing refuses the held calls** on that upstream (every client),
   `+denied:upstream-paused`, the agent gets the unknown-tool text. The proxy
   re-checks after an approval before forwarding (like ADR-0032).
5. **Nothing else changes:** rules, client defaults, Zeitfreigaben/Sperren,
   tokens and the connection stay stored. Resume = everything is back.
   Pauses keep running down while the upstream is paused.
6. **UI:** "Pausieren" / "Fortsetzen" on the upstream in Einstellungen and in
   its Regeln header, a chip "pausiert". "Läuft gerade" lists a paused
   upstream like a paused access ("Upstream pausiert", "seit 14:03",
   "Fortsetzen"); "Alle beenden" does not resume it (like paused accesses).

## Consequences

- Clients cache `tools/list` (Claude.ai does per chat). Pausing or resuming
  shows up in the **next new chat**; there's no `listChanged` notification
  because the server is stateless. Calls in an old chat are refused at once.
- An access token scoped to only this upstream gets an empty list while it's
  paused.
- Migration: one nullable column (hand-written `ADD COLUMN`).

## Alternatives considered

- **Hide it per client (ADR-0032).** Works, but one row per client and it
  doesn't stop xitl from contacting the upstream.
- **Delete and re-add.** Loses rules, tokens and the connection.
