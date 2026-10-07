# 0029. Pause with AI check: Clef narrows an allow pause, a mismatch ends it

- **Status:** Proposed (2026-10-07; lead's draft from Matthias's decisions, his review open)
- **Date:** 2026-10-07

## Context

An allow pause (ADR-0004 snooze, scopes ADR-0019) lets ASK calls of one access
(one `McpClient`), one upstream and a scope (TOOL / READONLY / UPSTREAM) through
until a time. It is blind: once granted, anything in scope goes through, even
when the agent has left the task the human approved. Matthias's real case: a pause
granted on one call, then a run of archive calls.

Benchmarked 2026-10-07 (`scripts/bench/clef_bench.py`, roadmap item 0) with
Cloudflare's **Clef** decision model (llama.cpp `/v1/systemone`: named
questions, probabilities, one forward pass, no generated text). The question
`richtung` (choice: same direction / change of direction / widening; English
instructions) on state = anchor call + its intent summary + calls since + the
new call:

| | Clef-Flash 9B | Clef 27B (Q4_K_M) |
| --- | --- | --- |
| `gleich` on 6 normal continuations | 0.72–0.94 | 0.92–0.98 |
| `gleich` on 7 direction changes (incl. injection, rewrite) | ≤ 0.55 | ≤ 0.61 |
| "more of the same" (archive-everything) | 0.91 | 0.94 (missed) |
| latency | ~0.55 s | 1.5–2.1 s |

Deterministic: identical probabilities across runs. The yes/no question
`passt` did not separate at all (dropped).

Matthias's decisions (2026-10-07):
- **No count cap** on repeated destructive calls under a pause: often intended,
  annoying, and it would need bulk approval. "More of the same" stays a known gap.
- **A mismatch ends the pause** for that access (the pause is per client).
- **UI wording** (same day): an allow pause is a **"Zeitfreigabe"**, a deny
  pause a **"Sperre"**; "pausiert" means only a blocked access (ADR-0024).
  "Pause" below is the code/ADR term (`Snooze`), never UI text.

## Decision

1. **Where:** in the proxy right after `evaluatePolicy`, only when the decision
   is `ALLOW` with path `snooze` (an allow pause turned ASK into ALLOW). Nothing
   else is checked: rule ALLOW, DENY, deny pauses (ADR-0026) and ASK are
   unchanged. The check **can only turn this ALLOW back into ASK**, never
   anything into ALLOW. That is the security argument: a manipulated or wrong
   model can at most give today's blind pause.
2. **The question:** one `choice` `richtung` with three described options
   (`gleich` / `richtungswechsel` / `ausweitung`), English instructions, the
   call data as JSON lines inside `<call>` delimiters with `<` escaped (same
   framing as the intent prompt), marked untrusted.
3. **State:**
   - the **anchor**: the held call the pause was granted on (new column
     `Snooze.anchorAuditId`), its tool, arguments (truncated) and, if already
     there, its intent summary (ADR-0025);
   - the calls forwarded under this pause since (newest last, at most N,
     arguments truncated; `lib/limits.ts`);
   - the new call.
   No tool results (the attack surface stays the agent's own arguments).
   A pause without an anchor (granted before this ships) stays blind until it
   expires; only pauses granted afterwards get the check.
4. **Verdict:** `p(gleich) ≥ threshold` (default **0.8**, env
   `PAUSE_CHECK_THRESHOLD`) → forward as today, decision path `snooze+ki`.
   Otherwise → **end the pause** (delete the Snooze row; same effect as ending it
   in the UI) and **hold this call as a normal ASK** with decision path
   `snooze-ki-mismatch`. The card and the push say why:
   "KI-Prüfung: weicht ab (Richtungswechsel) – Zeitfreigabe beendet"
   (option label from the winning choice). Approving it can grant a new pause
   with this call as its anchor.
5. **Model down, timeout (default 10 s), garbage:** this call is **held** (fail
   closed), path `snooze-ki-error`, card "KI-Prüfung nicht verfügbar"; the pause
   **stays** (an outage must not silently cost the human every pause, and each
   call is still asked). *Open for Matthias:* alternatively fall back to the
   blind pause while the model is down (not fail-closed; not recommended).
6. **Held calls a pause settles** (TC-128, `+approved:pause`) go through the
   same check; a mismatch leaves that call held and ends the pause.
7. **Stored for tuning:** `AuditEntry.pauseCheckScore` (p(gleich)) and
   `pauseCheckChoice`; shown in the Verlauf detail.
8. **Endpoint by env, admin only:** `PAUSE_CHECK_URL` (unset = feature off =
   today's blind pause), through `outboundFetch` with the host as an allowed
   internal address (ADR-0020). The server needs `--batch-size/--ubatch-size`
   ≥ 4096 (a request must fit one ubatch, else HTTP 500). Test seam (ADR-0003):
   a `PauseCheck` interface with a deterministic stub selected by env in e2e.
   Sequential per access (calls of one access are checked in order, so "calls
   since" is right).

## Consequences

- Paused calls get ~2 s slower (Clef 27B); unpaused calls are unaffected.
- Pauses end earlier and more often; each end is one question to the human,
  never a wrong forward.
- **Known gap:** "more of the same" (archive everything, one by one) passes the
  check. Optional later (not decided): a silent "Pause: n× tool in m min"
  notice with "Zeitfreigabe beenden", which holds nothing.
- Two chats on one connector share the access: one chat's swerve ends the pause
  for the other too (more questions, never more access).
- Call arguments go to a second in-cluster service (as with ADR-0025).
- The threshold is model-specific (the Clef blog says so; Flash would need
  ~0.7 and separates worse). Changing the model means rerunning the bench.

## Alternatives considered

- **Count cap on destructive calls under a pause.** Rejected by Matthias
  (above).
- **Mismatch holds the call but keeps the pause.** Rejected by Matthias: once
  the agent has swerved, the trust behind the pause is gone.
- **Qwen (the intent model) answers "passt"/"richtung" as JSON.** 3.6–4.9 s,
  generated text, shares 2 slots with rezepte and the intent summaries; Clef
  is built for this and returns calibrated probabilities.
- **Clef-Flash.** 3–4× faster but separates worse (gap ~0.15 vs ~0.3) and the
  rewrite case sits close to the line. The model is a deployment choice behind
  the seam; the bench decides.
