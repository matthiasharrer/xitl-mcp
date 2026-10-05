# 0017. The unified `/mcp` endpoint: names, auth, degradation

- **Status:** Accepted; auth amended by ADR-0018 (all-upstreams tokens work on `/mcp`); degradation made visible by ADR-0022 (state lines, push, Freigaben card)
- **Date:** 2026-10-05

## Context

ADR-0014 decided that `/mcp` serves all of a user's upstreams in one connector
with tool names prefixed `<slug>_`. Building it raised the open points the
roadmap listed: which tokens work there, how a prefixed name maps back, what
happens when one upstream is down, how sessions attach, and what the
instructions look like.

## Decision

- **Auth: OAuth only** (superseded by ADR-0018: all-upstreams tokens work too). `/mcp` accepts the inbound OAuth tokens (ADR-0012),
  which are bound to a user, not to an upstream. Per-upstream access tokens
  (ADR-0015) are scoped to one upstream by design, so on `/mcp` they get the
  same 401 challenge as any invalid token. The protected-resource document for
  `/mcp` names `resource` = `<origin>/mcp`.
- **Names:** a listed tool is `<slug>_<upstream tool name>`. Slugs cannot
  contain `_` (`^[a-z0-9][a-z0-9-]{0,31}$`), so the **first** `_` always splits
  slug from tool name: no collisions are possible, and no lookup table is
  needed. A prefixed name that breaks the MCP name rules
  (`^[A-Za-z0-9_.-]{1,128}$`) is not listed, and a call to it is denied as
  unknown, as is any name without `_` or with a slug the user doesn't have.
- **Calls** resolve the slug among the token user's own upstreams and then take
  exactly the `/mcp/<slug>` path: same policy (by the unprefixed name, so rules,
  snoozes and approvals are shared between both endpoints), same approval, same
  audit row with `endpoint = "/mcp"` and the unprefixed tool name. A call that
  resolves to no upstream is denied and audited with no upstream and the full
  name.
- **Degrade per upstream:** `tools/list` asks every usable upstream in parallel;
  one that fails, times out or needs reconnecting is left out of that list
  (logged), the others are listed. Upstreams that aren't usable (OAuth not
  connected) aren't contacted.
- **Instructions:** the xitl prefix line, one line explaining the naming, then
  one section per upstream (`## <name> — Tools <slug>_…`), with its description
  and its own instructions (each capped at 4 000 characters); unusable
  upstreams get a one-line note instead of a section body. Fetched live on
  `initialize` from every usable upstream in parallel, falling back to the
  stored ones.
- **Sessions (ADR-0016)** on `/mcp` belong to user + client with **no**
  upstream (`McpSession.upstreamId` becomes nullable). A `/mcp` session id is not
  valid on `/mcp/<slug>` and vice versa (404).

## Consequences

- `tools/list` on `/mcp` costs one upstream connection per usable upstream on
  every call (5–7 for us). Fine at personal scale; a short-lived cache is the
  fix if it ever matters.
- An agent that sees a tool on `/mcp` and the same one on `/mcp/<slug>` meets
  the same policy and the same approvals: one set of rules per user.
- A failing upstream silently drops its tools from the list; the agent sees
  fewer tools, not an error. The section in the instructions still names it.

## Alternatives considered

- **Per-upstream tokens on `/mcp` showing only their upstream:** works, but
  it's just `/mcp/<slug>` under another URL, and confusing.
- **Account-wide static tokens:** a new credential kind with a bigger blast
  radius; not needed while Claude Code can do OAuth. In `ideas.md`.
- **Failing the whole `tools/list` when one upstream fails:** one broken
  upstream would take every tool away.
