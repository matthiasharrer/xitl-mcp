# 0031. Review hint for new and changed tools (advisory), and inputSchema change detection

- **Status:** Accepted (2026-10-07, Matthias: "one just accepts all new tools
  anyway, at least a hint if something needs more attention"; build authorized)
- **Date:** 2026-10-07

## Context

A new tool is ASK "new-tool" until acknowledged; a changed one (description or
annotations differ from what xitl stored, TC-36 rug pull; or the upstream URL
changed, ADR-0021) is ASK "changed-tool", even over an explicit ALLOW. In
practice every one of them gets acknowledged without reading, so the check
protects little. What helps is telling the human **which** ones deserve a look.

Constraints:
- In a rug pull, the upstream is the attacker and the tool description is its
  text. A model judging that text can be targeted by it. So a model may only
  **label**, never acknowledge.
- `inputSchema` is not stored, so a changed parameter schema is not detected
  at all (roadmap debt). A new parameter (`recipient`, `delete_all`) is a
  classic rug-pull vector.

## Decision

1. **Store what changed.** `KnownTool` gains `inputSchema String?` (canonical
   JSON, size-capped like descriptions) and, set when a change is detected,
   `prevDescription`, `prevAnnotations`, `prevInputSchema` (the acknowledged
   versions). An `inputSchema` difference now counts as a change (sets
   `changedAt`, clears `acknowledgedAt`, ASK "changed-tool"), exactly like a
   description change. First sight of a schema on an existing row (after the
   migration) is stored silently, not a change.
2. **Deterministic hint first** (pure function `reviewHint(tool)`, unit-tested):
   - *Attention* ("Genauer ansehen"), each with a German reason:
     `readOnlyHint` true → false or missing; `destructiveHint` newly true;
     `openWorldHint` newly true; a new required parameter; a parameter removed
     or its type changed; description grown by > 50 % or more than 400 chars;
     the upstream URL changed (ADR-0021).
   - *Cosmetic*: description differs only in whitespace, punctuation or case,
     annotations and schema equal. **Auto-acknowledged** (the only automatic
     act; no model involved), recorded with path `auto-ack:cosmetic` in the
     tool's history so it stays visible.
3. **Clef label second, advisory** (when ADR-0029's Clef config is set and the
   switch is on; otherwise only the deterministic hint):
   - `risiko` (choice lesen / ändern / zerstören, as in
     `scripts/bench/clef_probes.py`) on name + description + annotations +
     schema; shown as "KI: wirkt <lesend|ändernd|zerstörend>". If it rates
     higher than the annotations claim (e.g. readOnlyHint but "zerstörend"),
     that is an *attention* reason.
   - `injektion` (noul, en question as benched) on the description and the
     schema's descriptions: ≥ 0.5 → *attention*: "Beschreibung enthält
     Anweisungen an KI-Agenten". Strong rug-pull signal.
   - Computed once per (tool, version) in the background after `tools/list`
     sees a new/changed tool, stored on `KnownTool` (`hintRisk`,
     `hintInjection`, `hintAt`); errors leave the label empty. Never on the
     call path.
4. **UI** (Regeln, the list of new/changed tools, and the Freigaben card of a
   held "new-tool"/"changed-tool" call): tools with *attention* sort first,
   highlighted, with their reasons; others show "Unauffällig". For a changed
   tool, a compact diff (old → new description, annotations, parameters).
   "Alle unauffälligen bestätigen" acknowledges only the unremarkable ones in
   one tap; *attention* tools need their own tap.
5. Nothing here can ALLOW a call or acknowledge a non-cosmetic change. A wrong
   or manipulated label costs attention, never access.

## Consequences

- Rug pulls via parameters are now detected (one more source of
  "Geändert" prompts; the cosmetic auto-ack and the bulk button keep the noise
  down).
- The label is attacker-influenced in exactly the rug-pull case; the
  deterministic reasons don't depend on the model, and the injection signal
  is the model's strongest contribution (bench: full Clef ≥ 0.83 on injected
  text, ≤ 0.13 on benign).
- Migration adds nullable columns only.

## Alternatives considered

- **Clef decides whether a change needs a human.** Rejected: the judged text
  is the attacker's.
- **No auto-ack at all.** Keeps every cosmetic edit as a prompt, which is what
  trained the human to click through.
