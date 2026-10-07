# 0028. Verlauf updates live over the existing approval stream

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Only Freigaben (held calls) updated live (`GET /api/approvals/stream`, SSE).
Verlauf and its detail page showed what they fetched on load: a new call, a
held call being decided, a call finishing, or an intent summary (ADR-0025)
arriving needed a reload. Matthias wants Verlauf live too.

Constraints: the stream is capped per user (`MAX_APPROVAL_STREAMS_PER_USER` = 5,
TC-45), so a second EventSource per tab is out. The stream only ever carries
the caller's own data (ADR-0010). Nothing may go out that the history API
(`GET /api/audit`) would not return to that user (ADR-0007: no upstream
credentials; the list omits arguments and result text on purpose).

## Decision

**A new event `history` on the existing stream, carrying one list row**, exactly
the shape of an entry of `GET /api/audit` (`serializeAuditRow`, the single
function both the route and the stream use).

- Source: an in-process emitter `lib/auditEvents.ts` (single replica, like
  `upstream/stateEvents.ts`). `{userId, auditId}` is emitted after every
  AuditEntry write: create (`mcp/server.ts` callTool and denyUnresolved), the
  outcome update (`finish`: approved/denied/timeout/cancelled/forwarded/failed,
  also "via pause"), and intent `save` / `skip` (`intent/store.ts`). Emitting
  never throws into the contact path.
- The stream handler, per connection, ignores events of other users and, for
  its own, **re-reads the row with the user in the query** and serializes it.
  The emitter carries ids only, so no data crosses users even if a listener
  check were wrong, and the payload can't drift from the list shape. Events
  are chained per connection so one row's updates arrive in write order (each
  carries the then-current row; a later read is never older than an earlier).
- Client: `openApprovalStream` gets a `history` handler. **Verlauf** applies
  the row with a pure merge (`lib/historyLive.ts`): known id replaced in place;
  new id inserted when it falls inside the loaded window (newer than the
  oldest loaded row, or all pages loaded), else ignored ("Ältere laden" gets
  it later). Grouping/day separators are derived from the entries
  (`lib/grouping.ts`), so a live row joins or starts a group like a fetched
  one. A fresh row gets a 4 s soft highlight. **HistoryDetail** refetches the
  detail (it has more fields than the list row: result text, diagnostics) when
  a `history` event for its id arrives.
- **Reconnect heals:** every (re)connect begins with `snapshot`. Verlauf and
  HistoryDetail refetch on every snapshot (Verlauf: the first page, merged
  with older pages already loaded; rows arriving during that fetch are applied
  on top of its result). So events lost while disconnected never leave the view
  stale. Only one route is mounted at a time, so a tab still holds one stream.
- No filters exist in Verlauf today; when one is added, `applyLiveRow` is where
  a live row must be tested against it.

## Consequences

- One query per `history` event per open stream (cheap; one user, ≤ 5 streams,
  a handful of events per call). Burst of N calls = N small reads.
- Verlauf now opens the stream (previously only Freigaben did); the 5-stream
  cap and its 429 behave as before.
- Not announced (the row changes without an audit write through our code): an
  access revoked or an upstream deleted nulls `mcpClientId`/`upstreamId` on
  old rows (FK `SetNull`), and the boot sweep ("+restart", intent PENDING →
  SKIPPED) runs before any stream exists. Those show up on the next load or
  reconnect.
- Stored retention/cleanup of old rows, should it come, must emit too if rows
  vanish (a `history` event can't say "deleted"; reconnect/refetch would).
- The event reveals nothing new: its field set is the list's.

## Alternatives considered

- **Id-only "changed" hint, client refetches.** Smaller wire format and no
  second serializer, but every event costs a client round trip (and a 50-row
  list fetch or a per-id detail call whose shape lacks `clientId`), plus
  ordering/race handling in the client. We still use refetch where the client
  needs more than the row (detail, reconnect).
- **Second EventSource / separate `/api/audit/stream`.** Breaks the one-
  connection-per-tab budget (TC-45).
- **Polling.** Not live, wasteful, rejected by the request.
- **Emitting the full row from the write site.** Would need userId-scoped
  reads and the include at every write; re-reading in the stream keeps the
  authorization in one place.
