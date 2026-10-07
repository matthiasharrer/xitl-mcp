# Roadmap

> **What's still open.** This file only holds work that is *not done*. Shipped
> entries move to `roadmap-archive.md` (create it with the first one) rather than
> being ticked off here. Ideas that aren't scheduled live in `ideas.md`; the
> reasoning behind decisions lives in `decisions/`.

_Last updated: 2026-10-07 (ADR-0031, ADR-0030 and the Zeitfreigabe purpose built, unreleased)_

## Next

State at the end of 2026-10-06: **`v0.8.0` released** (image `0.8.0` in
GHCR), `v0.7.0` deployed and running. GitOps already has `INTENT_LLM_URL`
(llama-cpp, alias `qwen`) and the NetworkPolicy.

**Open, in order:**

0. **Next session, together with Matthias: try Cloudflare Clef-Flash** for
   the "Pause mit KI-Prüfung" (ideas.md). llama.cpp PR #29831 (merged
   2026-10-03) adds Clef/Clef-Flash and `POST /v1/systemone`: `state` + named
   questions (`choice` with criteria map, `score` 2–10 levels, `noul` yes/no
   → probability), one forward pass, no text (`output_tokens: 0`). Router mode
   serves it next to Qwen (model per request); Clef-Flash Q4 ≈ 6.5 GB. Plan:
   (1) Matthias loads `ggml-org/Clef-Flash-GGUF` in his llama-server (needs a
   build with #29831; he restarts the workspace for the access); (2) lead
   writes a scratch benchmark: state = anchor call + intent, calls since the
   pause, new call; questions `passt` (noul: same intent continued?) and
   `richtung` (choice: gleiche Richtung / Richtungswechsel / Ausweitung);
   cases from real use (the archive-everything sequence, normal continuations);
   (3) look for a clean probability gap / threshold (the blog: cutoffs are
   model-specific); (4) if it separates, ADR, then Matthias decides. Design
   constraint stays: the check can only narrow a granted pause, anything else
   → ASK. Sources: github.com/ggml-org/llama.cpp/pull/29831,
   huggingface.co/blog/ggml-org/decision-models-in-llamacpp.

   **Status 2026-10-07:** Matthias runs Clef-Flash as its *own* service
   `http://llama-cpp-clef.ai.svc.cluster.local:8080` (not router mode; qwen
   on `llama-cpp` unchanged, its build b11429 already answers
   `/v1/systemone` with 501 "not a decision model"). From the workspace
   (pod in ns `coder-workspaces`) the clef Service resolves
   (10.152.183.113) but **TCP times out**, also after Matthias's
   NetworkPolicy update; he is updating/restarting the workspace. First
   step next time: `curl -m5 …-clef…:8080/health` → 200? Then run
   `python3 -I scripts/bench/clef_bench.py` (14 cases, 6 ok / 8 ask,
   de + en instructions; prints probabilities, latency, and the gap min-ok
   vs. max-ask for `passt` and `gleich`). API detail: each question's text
   field is **`instructions`** (not `question`); `noul` → `{noul: p}`,
   `choice` → `{choice, probabilities, confidence}`; describe each choice
   option (bare labels route worse, per the blog). Still wanted: real
   sequences from Matthias (the archive-everything run) as extra cases.

   **Result 2026-10-07 (first full run, 14 cases × de/en, 1 run):** the
   clef server needed `--batch-size/--ubatch-size 4096` (prompt must fit one
   ubatch, else 500 "input too large"; prompts are 470–650 tokens and grow
   with calls-since). Latency ~0.5–0.6 s (vs 3.6–4.9 s for qwen intent).
   `passt` (noul) is useless: ok cases at 0.05, archive-everything at 0.95,
   drop it. `richtung`/`gleich` works except for one case: all direction changes
   (add→archive, add→remove, injection, rewrite) are low; en: min ok 0.715,
   max ask 0.552 *without* archive-everything (de: 0.518 vs 0.522, en
   wording separates better). **archive-everything scores gleich ≈ 0.91**:
   "more of the same" is invisible to it (the model can't know ids 1–4
   aren't done). **Matthias, 2026-10-07: no count cap** (repeated destructive
   calls under a pause are often intended; a cap would be annoying and would
   need bulk approval). Plan: full Clef, en, `gleich` only, threshold ~0.8,
   below/timeout/error → ASK; "more of the same" (archive-everything) stays a
   documented gap, no worse than today's blind pause. Optional later: a silent
   "Zeitfreigabe: n× tool in m Min." notice with "Zeitfreigabe beenden" (holds nothing).
   Next: ADR, then build.
   `--runs 3` (en): **fully deterministic**, identical probabilities each run.
   More probes 2026-10-07 (`scripts/bench/clef_probes.py`, ~250 ms each):
   tool risk class from name + description (lesen / ändern / zerstören)
   20/22 (misses: remove_from_plan → ändern, n8n execute → zerstören at
   0.36), a seed for "LLM proposes policy"; injection detection in tool data
   (noul) catches imperative injections at 0.82–0.95 vs benign ≤ 0.09 (en
   question) / ≤ 0.37 (de), but **misses a fake `<system>` "user already
   agreed" claim** (0.05–0.07): a signal, never a guard.

   **Full Clef (27B, Q4_K_M 19.2 GB, same service, alias still
   `clef-flash`), 2026-10-07, en:** pause `gleich`: ok 0.922–0.980, ask
   ≤ 0.605 **except archive-everything 0.938** (still invisible; needs the
   count cap); typo-fix-then-rewrite now 0.05 (Flash 0.26), so a threshold
   ~0.8 forwards 6/6 ok and asks 7/8. `passt` still useless. 1.5–2.1 s per
   check (Flash ~0.55 s). Tool risk 20/22 (same two misses, higher
   confidence), ~0.8 s. Injection (en question): benign ≤ 0.13, injected
   ≥ 0.83 **incl. the fake `<system>` claim** (Flash missed it): clean gap,
   usable as a warning on the card (still never a guard).
   **Built 2026-10-07, unreleased:** ADR-0029 (Zeitfreigabe with AI check)
   is implemented (`apps/api/src/pausecheck/`, migration
   `20261006030000_pause_check`, TC-137…148 green). Deploy needs
   `PAUSE_CHECK_URL` in GitOps (optional `PAUSE_CHECK_THRESHOLD`,
   `PAUSE_CHECK_TIMEOUT_MS`, `PAUSE_CHECK_MODEL`); unset = blind pauses.

0b. **Review hint for new and changed tools** (Matthias, 2026-10-07: "one
   just accepts all new tools anyway, at least a hint if something needs more
   attention"). Build after ADR-0029 (reuses its Clef client). Advisory only,
   never decides (rug pull: the description is attacker text, see ideas.md).
   Per new/changed tool in Regeln: label "Unauffällig" vs. "Genauer ansehen"
   with reasons: deterministic first (annotations readOnly→not, new
   destructiveHint, description diff only whitespace/punctuation/case →
   auto-ack), then Clef: risk class (lesen/ändern/zerstören) and the
   injection noul on the description. Include `inputSchema` change
   detection (store it; today undetected, debt below). Small ADR first.
   **Built 2026-10-07, unreleased:** ADR-0031 (`apps/api/src/toolhint/`,
   `clef/` shared client, migration `20261006040000_tool_review_hint`,
   TC-149…154). Then **ADR-0030 AUTO policy built, unreleased**
   (`apps/api/src/auto/`, `routes/autoRule.ts`, migration
   `20261006050000_auto_policy`, TC-155…162; env `AUTO_THRESHOLD`, default
   0.8), and the **Zeitfreigabe purpose** ("Wofür?", ADR-0029 amendment
   pending, migration `20261006060000_pause_purpose`, TC-163…166), extended
   to the **Sperre** (Clef may turn a call clearly outside the Sperre's
   purpose into ASK, never ALLOW; migration `20261006070000_sperre_purpose`,
   TC-167…171; ADR-0026 amendment pending). Deploy
   needs nothing new beyond `PAUSE_CHECK_URL` (one Clef for all three; the
   switch "KI-Prüfung (Clef)" covers all). Open: MG-10/11 on the deployed
   instance (real tools, real rules via "Mit Verlauf testen").
1. **Deploy `v0.8.0`** (Matthias bumps the tag in GitOps).
2. **TC-128 e2e** (a pause settles the covered held calls): hold 3 calls of
   one tool + 1 of another tool + 1 of another client, approve one with a
   15-min TOOL pause → the 2 same-tool calls are forwarded (`+approved:pause`),
   the others stay held; same for a deny pause; toast count. Only unit-tested
   so far.
3. **MG-08 on the phone** (ADR-0025): summary within seconds, replacement
   push silent. **Watch Android:** pushes that show nothing (dropped intent
   update, and since `v0.8.0` every "resolved" push, which now only closes
   the notification) may make Chrome show its generic "site updated in the
   background" notification. If so: send "resolved"/update pushes only when
   needed, or show a short silent outcome again.
4. **Intent quality from real use:** titles tend to be generic for long names
   ("Putzaufgabe anlegen"); "Richtungswechsel" not always on the first
   swerving call; requests 3.6–4.9 s with thinking 128 (target ≤ 5 s). Tune
   with real examples from Matthias.
5. **Per-message trace id → intent "new user message" marker**, built
   generically (`correlate(diagnostics)`, ideas.md, test plan there). First
   confirm with two parallel Claude.ai chats.
6. **Deny pause:** calls already held when the pause is set are now settled
   by it (`v0.8.0`); the ADR-0026 "not done" note is resolved by TC-128.
7. **LLM proposes policy, user confirms in the app** (ideas.md): design + ADR
   first, then Matthias decides.
8. MG-05 (Tina), whenever convenient.

**To prioritize (Matthias, 2026-10-06, not ordered yet):**

- **Per-client default per upstream** (Matthias, 2026-10-06: decided "volle
  Voreinstellung", not built yet). Trigger: with everything on `/mcp`, the
  Claude.ai client sees Rezepte twice (`rezepte_…` and the work copy
  `rezepte-arbeit_…`). New per (client, upstream) policy ALLOW / ASK / DENY,
  between the upstream default and per-tool rules; a per-client tool rule
  still wins. **DENY = upstream invisible to that client**: no tools in
  `tools/list`, no section in `/mcp` instructions, calls denied, and it beats
  "new/changed tool → ASK" (else new tools reappear). Pauses don't change it.
  UI: one row per client under "Pro Client" in the upstream's rules (Voreinst.
  / Erlauben / Fragen / Verbieten). Makes the double-upstream workaround
  unnecessary. Needs an ADR (policy change) and fail-closed cases (DENY never
  listed/forwarded, incl. new tools, unified and per-slug endpoints).
  Workaround today: per-client DENY on every tool (DENY tools are already
  hidden from `tools/list`).

- **Optional reason when denying**, passed to the agent in the denial text
  ("[xitl] Abgelehnt: <Grund>"), e.g. "falsches Tool, nicht nochmal
  versuchen". One tap must stay one tap without a reason. Options: an
  optional text field on the card/detail always visible above the buttons
  (empty = as today); or a few quick chips ("Falsches Tool", "Nicht
  nochmal") plus free text. Not on the lock-screen action. The reason comes
  from the human, so it is instruction to the agent by design; length-cap it
  and store it on the audit row. Also fits the deny pause (ADR-0026).

Ideas noted 2026-10-06 (ideas.md): session descriptions by the intent model;
per-client policy floor / DCR `client_name` per upstream / profiles (work
agent platform; the double-upstream workaround suffices for now).

## Milestone 1 status

Deployed (`v0.8.0` is the latest release; `v0.7.0` running) and in daily use: Matthias's
Claude.ai uses the unified `/mcp` connector (Haushalt, Rezepte, Einkaufsliste
behind it) from 2026-10-05 on. Manual gates MG-01…04, MG-06 and MG-07 passed
(`testing.md` run log). **Open:**

- **MG-05:** Tina's own consent and Haushalt connection, no cross-user
  visibility. Needs Tina.

**Production rules (still binding):** never set `APPROVAL_TIMEOUT_MS` or
`PUSH_OUTBOX`; the ingress must not buffer `/api/approvals/stream` (SSE) and
must allow responses up to 300 s on `/mcp/*`; `/oauth/authorize` and `/api/*`
stay behind Authelia.

## Debt and open points (from slice 1+3 review, 2026-10-04)

- **Dev server proxies only `/api`:** `/mcp`, `/oauth`, `/.well-known` are
  reachable on :3002 only, not via the Coder URL, so Claude.ai can't be tested
  against the workspace. Add Vite proxy entries if that's wanted.
- Approval stream cap (`MAX_APPROVAL_STREAMS_PER_USER` = 5 per user) counts
  open SSE connections, not devices: every tab takes a slot, and a half-dead
  connection holds its slot until the server notices the abort. In-memory,
  which is exact with the single replica.
- **Grouping (ADR-0019, built):** time gaps per client (10 min); two chats in
  parallel on one connector share a group.
- **READONLY pause trusts `readOnlyHint`** as declared when the tool was first
  seen/acknowledged (ADR-0019 consequence).
- **Sessions:** expire after 30 days unseen, ≤ 500 per user (cleanup at boot
  and on create, no timer); unknown session id →
  404 per spec — if MG-06 shows Claude.ai breaking on 404, serve unknown ids
  sessionless instead (deliberate deviation); 2026-07-28-era clients have no
  sessions at all (grouping falls back to time gaps for them).
- **e2e ordering trap:** TC-16 assumes `anna` has no connected upstream; specs
  that connect one for her must use another user.
- **Decided 2026-10-04 (Matthias), no change:** lock-screen "Erlauben" stays
  for all tools, destructive ones included (summary is agent-controlled;
  accepted).
- ~~`inputSchema` changes aren't detected (not stored).~~ Done (ADR-0031): stored canonically, a change is "changed-tool".
- Boot sweep labels an ALLOW call that crashed mid-forward `DENIED +restart`,
  though it may have reached the upstream.
- **Unified `/mcp`:** `tools/list` fans out to every usable upstream per call
  (no cache, ideas.md); a failing upstream is left out (the user gets a push +
  Freigaben card, ADR-0022); no `list_changed` there either.
- **Failure state (ADR-0022):** `lastFailureAt` lags: a recovered upstream
  stays "nicht erreichbar" until its next contact; a row can hold a stale
  `lastFailureAt` next to `NEEDS_RECONNECT` (reconnect wins in UI/agent text,
  cleared by the first successful contact after reconnecting). A tool call
  timing out (120 s) counts as a failure. No background probing: a failure is
  only noticed at the next contact. Push cooldown is in memory (a restart
  can push again). "Neu verbinden" from a Freigaben card returns to
  Einstellungen, not Freigaben.
- **CORS (ADR-0023):** the preflight is unauthenticated and does one DB query
  (narrowed `contains`); fine at household scale. The 403
  `origin_not_allowed` carries no CORS headers, so the page sees a CORS
  failure, not the body. OAuth clients have no origins yet.
- **Pause (ADR-0024):** a call already past the gate when the pause lands
  still runs (same window as revoke); Claude.ai's reaction to the 403 is
  unmeasured. Rename/revoke in the UI still show the API's English "not
  found" on a 404 (pause has its own German toast).
- Only `tools` are proxied (no resources/prompts); no `list_changed`
  notifications (stateless endpoint; next `tools/list` sees changes).
- DCR cleanup (TC-88): prune-then-create isn't atomic, so concurrent
  registrations can briefly exceed `MAX_UNBOUND_CLIENTS` by a few; the next
  registration (or boot) corrects it. Registration spam can evict a client
  that is mid-consent (it fails closed: "Unbekannter … client_id", register
  again).
- Signed auth codes are replayable within 60 s (needs PKCE verifier too),
  copied caveat from Haushalt.
