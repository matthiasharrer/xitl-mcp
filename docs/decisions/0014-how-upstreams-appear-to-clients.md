# 0014. Upstreams reach clients two ways: one endpoint each, or all in one

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

With 5–7 upstreams, the agent needs to know what belongs together and what each
group is for (Matthias). Two shapes: one MCP endpoint per upstream (grouping and
instructions native, per-connector toggles in Claude.ai, one connector to add
per upstream) or one aggregated endpoint (add once, all tools always there).
Matthias wants both; tool search in current clients makes the "too many tools
in context" cost of aggregation small.

## Decision

- **Both endpoints exist for every user, always**, no setting:
  - `/mcp/<upstream-slug>`: one upstream. Tool names, descriptions and the
    upstream's server instructions pass through unchanged (plus the policy
    stamp below).
  - `/mcp`: all of the user's connected upstreams. Tool names get the prefix
    `<slug>_` (collision-proof); the server instructions are generated: one
    section per upstream with its description and its own instructions.
  - Settings shows both URLs; the user picks per client.
- **Policy stamp:** each listed tool's description gets the user's current
  policy, generated: `ask` → e.g. "Erfordert Freigabe durch <Name>; Antwort
  kann bis zu 5 Minuten dauern." `deny` → **the tool is not listed** (and a
  call to it is still denied and audited). `allow` → no stamp.
- A policy change sends `notifications/tools/list_changed` to the user's open
  sessions.
- Policy and audit don't care which endpoint a call came through; the audit
  records it anyway.

## Consequences

- Milestone 1 (one upstream) builds `/mcp/<slug>` only; `/mcp` comes with the
  second upstream, when aggregation means something.
- A tool hidden as `deny` is invisible to the agent, which is the point; the
  user sees it in the policy UI.

## Alternatives considered

- **A per-account setting choosing one shape.** Nothing gained over offering
  both URLs; a setting would only hide one of them.
