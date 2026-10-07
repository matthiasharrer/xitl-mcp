# 0032. A default per client and upstream; "Verbieten" hides the upstream from that client

- **Status:** Accepted (Matthias, 2026-10-07)
- **Date:** 2026-10-07

## Context

Since everything goes through the unified `/mcp` (ADR-0017), every client sees every
upstream of its user. The Claude.ai client sees Rezepte twice: `rezepte_…`
and the work copy `rezepte-arbeit_…`. The duplicates cost context and invite the
agent to pick the wrong one. The workaround today is a per-client DENY on every
tool (DENY tools are already left out of `tools/list`). That's tedious, and it
breaks the moment the upstream adds a tool: the new tool is ASK
"new-tool" (ADR-0004), so it shows up again for that client.

ADR-0004 already allows per-client overrides, but only per tool
(`ClientToolPolicy`). Matthias decided on 2026-10-06 to add a full default:
**"volle Voreinstellung"**, one policy per (client, upstream).

## Decision

1. **New row `ClientUpstreamPolicy` (mcpClientId, upstreamId, policy)**. It has
   the same scope rules as `ClientToolPolicy`:
   - it belongs to the user, and the client must be able to reach the upstream (`reachesUpstream`)
   - it is written only through `/api` (Authelia, ADR-0011), never through `/mcp`
   - no row = "Voreinst." (the upstream default)

2. **Precedence in `evaluatePolicy`**:

   | # | Step                                        | Result | Path |
   | - | ------------------------------------------- | ------ | ---- |
   | 1 | tool unknown                                | DENY   | `unknown-tool` |
   | 2 | **client × upstream = DENY**                | DENY   | `client-hidden` (new) |
   | 3 | live deny pause                             | DENY   | `snooze-deny` |
   | 4 | per-client tool rule                        | it     | `policy:client` |
   | 5 | per-tool rule                               | it     | `policy:tool` |
   | 6 | changed / new tool                          | ASK    | `changed-tool` / `new-tool` |
   | 7 | **client × upstream (ALLOW / ASK / AUTO)**  | it     | `policy:client-upstream` (new) |
   | 8 | upstream default                            | it     | `policy:upstream-default` |

   After that, the allow pause post-step applies unchanged.
   - **DENY is absolute (step 2).** It beats everything: client tool rules, tool
     rules, pauses, and new or changed tools. The Sperre-with-purpose relax
     (ADR-0026 amendment) can't touch it either, because it only acts on
     `snooze-deny`. An allow pause can't open it, because pauses only ever upgrade ASK.
     This deviates from the roadmap note ("a per-client tool rule still wins"):
     otherwise a hidden upstream would leak single tools without their
     instructions section. To let a client have only some tools, set its
     default to "Fragen" (or Erlauben) and DENY the rest per tool. **The
     client's own tool rules are masked, not reset**: they stay stored, are
     shown as ineffective (§5), and apply again once the default is no longer
     Verbieten. Matthias, 2026-10-07: visible masking, no reset, no dialog.
   - **ALLOW / ASK / AUTO replace the upstream default for this client
     (step 7).** Explicit tool rules (5) still win, and new or changed tools stay
     ASK, as with the upstream default. AUTO uses the upstream's `autoRule`
     (ADR-0030), the same as an AUTO tool rule.
     So a global tool ALLOW also beats "Fragen" for one client. One rule,
     most specific first: **Client-Regel > Tool-Regel > Client-Voreinst. >
     Upstream-Voreinst.**, with Verbieten as the client default as the only
     exception. Rejected: "the client default can only tighten tool rules"
     (stricter-of), which is harder to predict. Stricter for one client = a
     client tool rule, made easy by the client view (§5).

3. **"Hidden" means hidden everywhere the client looks**:
   - `tools/list` (both endpoints): no tools of the upstream at all, including new ones.
   - `/mcp` instructions: no section and no state line for the upstream. ADR-0022's
     failure notice is left out too.
   - `tools/call`: refused **with the same text as an unknown tool**
     (`MSG.unknownTool`), so no oracle tells the client "exists, but forbidden". The
     audit row says `DENY` / `client-hidden`, so Verlauf shows the truth.
   - `/mcp/<slug>` of a hidden upstream (only an OAuth or all-upstreams
     client can reach it, since a token for that upstream makes the setting pointless):
     `initialize` answers with only xitl's prefix line and no upstream
     instructions, `tools/list` is empty, and calls behave as above. The
     alternative is a 403 at the gate. Rejected: it would be a second refusal path in
     `mount.ts`, for a case that only happens when someone deliberately points a
     client at a hidden slug.
   - Intent summary (ADR-0025): a `client-hidden` call is `SKIPPED`, the same as
     `unknown-tool`.

4. **Changing the setting affects calls already held** (an edge case, but cheap). When a client's
   default for an upstream is set to DENY, its held calls on that upstream are
   refused (`client-hidden`), the same way a Sperre settles held calls
   (ADR-0026). Other values leave held calls alone, because the user decides those anyway.
   Otherwise a call that is now forbidden still pops up for approval on the phone.

5. **UI: a client view in Regeln, so the precedence is visible.**
   - A switch at the top of an upstream's Regeln: **"Gilt für: Alle Clients |
     <client> | …"** (the clients that can reach the upstream, paused ones
     included).
   - **Alle Clients** is today's view. A tool's own client overrides stay in
     its "Pro Client" details. A rule masked by a hidden upstream shows there
     greyed out: "wirkungslos: Upstream für <client> verborgen".
   - **One client:** the client's default for this upstream sits at the top:
     **Voreinst. / Erlauben / Fragen / KI / Verbieten**. "KI" is offered only
     where AUTO is, like the tool rules. Every tool row shows that client's
     **effective** policy with its source ("Verbieten · Client-Regel",
     "Erlauben · Tool-Regel", "Fragen · Client-Voreinst.", "Fragen · neu").
     The row's control edits **that client's** tool rule directly, where
     "Wie für alle (<value>)" means no client rule. With the default on
     Verbieten, the view says "Für <client> unsichtbar: keine Tools, kein
     Abschnitt in den Anweisungen". Every tool then shows "Verborgen ·
     Client-Voreinst." and any stored client rule shows as masked. The
     controls stay usable, so rules can be prepared.
   - The precedence line from §2 is shown in the client view.
   - **The client's page** gets one read-only line: "Sieht: Haushalt,
     Rezepte · Verborgen: Rezepte Arbeit".
   - The effective policy per tool for a client comes from the API (the same
     `evaluatePolicy` as the proxy, without pauses), never recomputed in the
     web app.

6. **Fail closed:**
   - An unrecognised value in the new row is DENY (`sane()`), which means hidden.
   - A failed read of the row denies the call (no fallback to the upstream default).
   - Listing and calling use the same evaluation, so a client that skips
     `tools/list` gains nothing.

## Consequences

- The double-upstream workaround (per-tool DENY per client) is no longer needed. Matthias
  sets "Verbieten" once on `rezepte-arbeit` for Claude.ai. The old per-tool DENY
  rows can stay. They're harmless, and the UI shows them as masked.
- Disabling one tool for one all-upstreams client already worked (a client tool
  rule DENY) but was buried in a per-tool details block. The client view makes
  it one tap, with the result visible.
- `evaluatePolicy` gains one input (`clientUpstream: Policy | null`), which is required, like
  `changedAt`, so forgetting it doesn't quietly fall back. The Regeln view calls
  it with `null` (what a client with no client default sees).
- New test cases (fail closed): a hidden upstream is never listed or forwarded,
  on both endpoints and including a tool that appears after the setting; no instructions
  section; the call text is identical to an unknown tool's; an allow pause, a
  client tool ALLOW, a tool ALLOW and a Sperre-with-purpose relax all stay DENY;
  a corrupted value is DENY; held calls are settled when it's set.
- A migration with one new table. `ON DELETE CASCADE` on both client and upstream.
  An upstream URL change (ADR-0021) does not reset the row, because hiding is not trust.

## Alternatives considered

- **Keep per-tool DENY per client (today).** New tools leak through, and it means one
  click per tool.
- **A per-client upstream allowlist on the token/consent (scope, like ADR-0018).**
  It's stronger: the client wouldn't even reach the upstream. But OAuth clients
  would need a scope screen at consent, and it can't express Fragen or Erlauben. It's
  the "profiles" idea in `ideas.md`. Not now.
- **Hidden = only left out of the list, calls still evaluated normally.**
  Rejected. An agent that remembers or guesses the name gets around it, and an
  unknown tool already gets the stricter treatment today.
