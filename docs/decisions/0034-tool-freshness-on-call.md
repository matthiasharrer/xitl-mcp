# 0034. A call re-checks the tool list when it is older than 5 minutes

- **Status:** Accepted (Matthias, 2026-10-07)
- **Date:** 2026-10-07

## Context

Change detection (ADR-0004 new tools, TC-36 rug pull, ADR-0031 inputSchema)
only runs when a client lists tools through xitl or the user taps "Tools
aktualisieren". Clients cache the list: Claude.ai lists at the start of a
chat and then calls for as long as the chat runs. Matthias changed an n8n
workflow behind Einkaufsliste; xitl only saw the change after a manual
refresh. A call to a changed tool in that window is decided on the old,
acknowledged definition, so an explicit or default ALLOW forwards it to the
new behaviour.

## Decision

- **Every upstream stores `toolsSyncedAt`**, set by every successful
  `syncKnownTools` (proxied list, "Tools aktualisieren", this re-check).
- **Before a `tools/call` is decided**, if `toolsSyncedAt` is null or older
  than **5 minutes** (Clock; `TOOLS_FRESH_MS`, env-overridable for tests),
  xitl lists the upstream's tools and syncs them first, then evaluates. A
  change found that way makes the call ASK `changed-tool` (new tool: `new-tool`;
  a vanished tool: `unknown-tool`).
- **Single-flight per upstream:** concurrent calls share one re-list.
- **Fail closed:** if that re-list fails, the call is refused with a generic
  error (audit DENIED `stale-tools`) and never forwarded on a definition xitl
  couldn't check. (An upstream that can't list would almost always fail the
  call itself, too.)
- Not for a paused upstream (ADR-0033) or one hidden from the client
  (ADR-0032): those are refused before anything is contacted.
- The Regeln page re-reads when a sync changed something (existing approval
  stream, payload-free event), so proxied syncs show without a manual refresh.

## Consequences / accepted limits (Matthias, 2026-10-07: "5 min reichen")

- **A change inside the 5-minute window still passes** on the old definition.
- **Behaviour changes without a definition change are invisible**: a
  different workflow behind the same name, description and parameters looks
  identical. Only ASK or AUTO protects against that.
- At most one extra tools/list per upstream every 5 minutes; the first call
  after a quiet spell is slower by one list round trip.

## Alternatives considered

- **Re-list before every call.** Closes the window completely but costs one
  round trip per call. Matthias chose 5 minutes.
- **Only on a schedule (background).** Contacts upstreams nobody uses and
  still leaves a window.
