# 0037. A built-in upstream `xitl`: read the Verlauf and the upstreams over MCP

- **Status:** Accepted (2026-10-21, Matthias: generic Verlauf access with filters plus upstream metadata, no Zugriffe; "wir schauen uns erst die Fälle an", so no "nur hinweisen" switch yet)
- **Date:** 2026-10-21

## Context

The KI-Prüfung of a Zeitfreigabe (ADR-0029) blocks too often on longer tasks
("Richtungswechsel"; Matthias 2026-10-21: "für komplexere Dinge aktuell echt
unbrauchbar"). To tune it we need his real cases, and a case is not one row:
Clef judged the new call against the anchor, the purpose and up to 8 calls
since. Copying that out of the Verlauf by hand is impractical. Matthias's
idea: let an agent read xitl itself over MCP, approved like any other call.
He wants it generic (the Verlauf with filters, plus the upstreams' basic
metadata), not a one-off "mismatch export".

ADR-0005 once planned a "meta MCP server" (discovery read-only, drafts, apply
by CLI only); it was rejected with config-as-code (ADR-0011). Its discovery
tier is what this revives, without the draft tier.

## Decision

1. **An upstream kind, not a second server.** `UpstreamAuth` gets `BUILTIN`.
   A BUILTIN row is an ordinary `Upstream` row (slug `xitl`, name `xitl`,
   url `builtin:xitl`, status CONNECTED, default policy ASK), so policy, tool
   rules, client defaults (ADR-0032), pausing (ADR-0033), Zeitfreigaben with
   KI-Prüfung, Sperren, audit, intent, review hints and freshness all apply
   unchanged. Only `withUpstream` differs: for BUILTIN it connects the
   `Client` to an in-process MCP server over an in-memory transport, built for
   the row's `userId`. No HTTP, no fetch, no credentials; ADR-0027's
   self-loop guard is not involved (nothing goes out).
2. **Opt-in per person.** Einstellungen offers „xitl als Upstream hinzufügen“
   (only when the person has none). It creates the row; deleting it works like
   any upstream. The normal create / PATCH routes refuse `auth: BUILTIN`, and
   a BUILTIN row's url / auth / header / allowInternal can't be changed (400
   `builtin_fixed`); name, description and default policy can. OAuth connect
   on it is 400.
3. **Read only, for good.** Three tools, all `readOnlyHint: true`:
   `list_upstreams`, `list_history`, `get_history_entry`. **No tool that
   changes rules, Zeitfreigaben, Sperren, settings, clients or upstreams will
   be added**, with or without approval: an agent must never be able to
   loosen its own leash, and one hasty tap is enough. Changing this needs a
   new ADR.
4. **What leaves, what never does.** Every query is scoped by the row's
   `userId`. Whitelisted serializers only, never a spread of a row.
   - Upstreams: slug, name, description, state, tool count, last call. Never
     url, auth kind, header name/value, tokens, OAuth data, default policy,
     tool rules, AUTO rule, instructions, allowInternal.
   - Verlauf: never the upstream's **result text** (another server's output
     would enter another chat: an injection path; Clef never sees results
     either, TC-147), never `intentPrompt` / `intentAnswer` (they contain
     results), never diagnostics. Arguments, decision, scores, purpose, deny
     reason and the DONE intent summary/title do leave: they are the case.
   - Zugriffe (clients, tokens) are not listed (Matthias).
5. **The exact Clef input is stored.** A checked call (match or mismatch)
   stores the state string sent to Clef (`AuditEntry.pauseCheckInput`, ≤
   `MAX_PAUSE_CHECK_STATE_CHARS`). `get_history_entry` returns it, so a case
   is exactly what Clef saw. Rows from before this have none; for them the
   entry reconstructs it best effort (anchor via the pause row if it still
   exists, calls since via `pauseSnoozeId`) and says so.

## Consequences

- Matthias (and I, through the XITL connector in the workspace) can pull
  cases directly; every pull is a Freigabe on his phone unless he sets a rule.
- The Verlauf holds every upstream's arguments (Home Assistant actions, task
  texts). An approved `list_history` puts them into that chat. Approval per
  call is the guard; he should know.
- An agent could learn what Clef accepts. Negligible: the prompt is in the
  repo anyway.
- Every BUILTIN-unaware code path (OAuth, URL checks, the forms) has to treat
  the kind explicitly; a missed one must fail closed (refuse), never fetch
  `builtin:xitl`.
- The relief for the blocking itself (e.g. "nur hinweisen", threshold,
  prompt, anchoring on the purpose) comes after looking at the cases.

## Alternatives considered

- **"Fall kopieren" button in the Verlauf.** Simpler, but manual per case and
  useless to an agent working on the tuning.
- **A separate `/mcp/meta` endpoint with its own auth.** Duplicates policy,
  approval and audit; the upstream kind gets them for free.
- **Calling `/api/audit` over HTTP from xitl.** Behind Authelia, and a
  self-call is what ADR-0027 forbids.
- **Created for every user automatically.** Exposes the Verlauf to every
  connected agent's tool list without anyone asking for it; opt-in instead.
