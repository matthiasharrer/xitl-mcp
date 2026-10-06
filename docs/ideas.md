# Ideas

> Parking lot for things that are **not scheduled**. An idea moves to
> `roadmap.md` when it's decided and scheduled. Keep entries short and dated.

## From the briefing (2026-10-04): not decided or deliberately deferred

- **Discovery/config UI:** a lean, mostly read-only browser for upstreams and
  policies.
- **Payload-level snooze** ("stop asking about this query shape") via LLM
  similarity. Deferred **until the reviewer side has injection protection**.
- **Queue/resume** as the async approval model (job id, polling or re-present
  next turn). The alternative to auto-deny if slow reviewers turn out to be
  common (ADR-0004).
- **Per-platform defaults:** Claude.ai's hard 300 s limit vs Claude Code's
  configurable timeout.
- **Timeout policy per rule** (auto-deny, retry or queue), e.g. different for
  destructive vs read-only.
- **MCP elicitation** as the protocol hook for "waiting on a human". Doesn't
  solve the 300 s problem, but expresses it cleanly.
- **Progress notifications** mirrored to a push channel, not only the client
  dialog.
- **Multi-reviewer escalation and multi-admin** with a real user store. Out for
  personal use; the path to a team version.
- **Field-level audit redaction/encryption.** Becomes relevant with a second
  reviewer, weaker disk guarantees, or an upstream returning secrets-manager
  output (ADR-0008).
- **Other delivery channels:** Pushover, FCM/APNs, Slack/Teams.
- **Prior art to borrow from:** YAML rules with named approvers
  (microsoft/agent-governance-toolkit), integrity levels (gh-aw-mcpg),
  prompt-injection guardrails (enkrypt), hash-chained audit (SidClaw).

## From the review with Matthias (2026-10-04)

- **LLM proposes policy, user confirms in the app.** Replaces the meta server
  (ADR-0005, rejected). Never an MCP tool that applies.
- **Reviewer agent** (ADR-0006, deferred): the intent summary is built
  (ADR-0025, local Qwen via llama.cpp); a deciding reviewer still needs more
  injection protection than a risk floor. Could reuse ADR-0025's queue and
  context builder.
- **Different policy per client, e.g. a work agent platform** (Matthias,
  2026-10-06). Works today: add the upstream a second time (URL isn't
  unique, e.g. `rezepte-arbeit`, default ASK, own DCR registration at the
  upstream) + a one-upstream token (ADR-0015). Matthias: enough for trying
  it out. Later, if wanted: DCR `client_name` "xitl – <Upstream>" (both
  registrations are called "xitl" today); a per-(client, upstream) policy
  *floor* (can only tighten); profiles (Arbeit/Privat) instead of users
  without Authelia (ADR-0010 stays).
- **Use Claude.ai's per-message trace id** (ADR-0016 measurement
  2026-10-06: same trace id for all calls of one user message, new per
  message). (a) Intent context: mark a turn as "neue Nachricht des Nutzers"
  when its trace id differs from the previous call's, so a change of
  direction caused by a new instruction reads differently from one inside
  the same instruction; cheap, append-only. (b) Verlauf: sub-group per
  message; (c) split parallel chats whose turns overlap. First confirm with
  two parallel chats. Never for policy (client-sent).
  **Build it generic** (Matthias): one pure function
  `correlate(diagnostics) -> { chatKey, turnKey, source }` with a small
  table of per-client rules (e.g. `x-anthropic-client: ClaudeAI` -> turnKey =
  trace id; an MCP session -> chatKey = session id); unknown clients -> null
  (time gaps as today). Normalized `chatKey`/`turnKey` on AuditEntry;
  intent, Verlauf and grouping read only those. A new client = one rule + a
  unit test with its recorded diagnostics; raw diagnostics stay stored, so
  keys can be recomputed. Test plan: (1) two messages: create, then "archive
  everything" -> no direction-change warning; (2) one message doing both ->
  none either; (3) one message where an injected tool result makes the agent
  swerve mid-turn -> warning.
- **Session description by the intent model** (Matthias, 2026-10-06): one
  line per group header in Verlauf ("Putzplan angelegt, dann versucht, alle
  Aufgaben zu archivieren (abgelehnt)"). Cheap as a *branch* off the cached
  context (prefix + one question, answer not stored in the chain). Needs a
  server-side group identity first: Verlauf groups (web grouping.ts: day +
  10-min gaps) and intent contexts (source key, 20-call cap) can split
  differently. Trigger when the group goes idle (+ maybe after held calls).
- **Intent summary with tool results** in the context (declined for now,
  ADR-0025): better narratives, second injection source.
- **stdio upstreams:** wrap them into HTTP elsewhere and connect as usual.
- **Cache `tools/list` on `/mcp`** for a few seconds per user + client if the
  fan-out (one upstream connection per upstream per list) ever shows up.
- **Pause with AI check** (Matthias, 2026-10-06): "15 Min erlauben, aber die
  KI prüft, ob es noch zum Intent passt". Safe shape: the check can only
  *narrow* a pause the human granted (passt -> forward; passt nicht / LLM
  down / slow / garbage -> back to ASK with push), so a fully injected model
  gets at most what a blind pause gives today. Anchor = the call the pause was
  granted on (+ its intent summary), frozen at grant time (no drift via
  call-by-call comparison); optionally one line typed by the user. Separate
  prompt from the summary (ADR-0006), strict `{passt, grund}` with grammar,
  priority over summaries in the queue (2 shared llama.cpp slots). ADR-0006's
  "writes always escalate" needs an amendment (the human already allowed
  them); destructive could still always go back to the human. Model
  candidate: Cloudflare **Clef-flash** (9B, Qwen3.5-9B base, Apache 2.0,
  GGUF 6.5 GB Q4): a decision model returning per-option probabilities in one
  forward pass, pitched for exactly this ("does the tool call match the
  user's goal"). As of 2026-10-06 its decision head needs llama.cpp PR #29831
  (`/v1/systemone`), not in stock llama.cpp. Until then: Qwen, model behind
  the seam.
- **Fresh DCR on a manual reconnect** (2026-10-06): if an upstream deletes
  xitl's registration, "Neu verbinden" keeps sending the stored client_id and
  fails ("Unbekannter oder abgelaufener client_id-Parameter") until the URL
  changes (which resets `oauthClient`). Registering anew on every manual
  connect fixes it; cost: stale "xitl" entries pile up at the upstream. Seen
  only via the self-loop (ADR-0027), which was the actual cause of the
  "missing registration" report; the suspected consent rename was not it.
