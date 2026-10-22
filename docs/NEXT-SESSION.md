# Übergabe: Richtungswechsel-Fälle holen (temporär)

> **Temporäre Datei.** Wurde am 2026-10-21 als Übergabe an die nächste Session angelegt. Löschen, sobald die Fälle im Bench sind und der Hebel entschieden ist. Danach gehört der Stand in `roadmap.md`/`worklog.md`.

## Ziel

Die KI-Prüfung (Clef, ADR-0029) von Zeitfreigaben blockiert zu oft mit „Richtungswechsel“. Matthias sagt: „für komplexere Dinge aktuell echt unbrauchbar“. Wir sammeln seine echten Fälle und entscheiden dann, wo wir ansetzen. **Noch keine Entlastung (kein „nur hinweisen“) bauen.** Matthias will dazu wörtlich: „wir schauen uns erst die Fälle an“.

## Stand

- `v0.16.0` ist released und damit deployed. Es bringt den eingebauten Upstream `xitl` (ADR-0037) mit drei Read-only-Tools: `list_upstreams`, `list_history` und `get_history_entry`.
- Matthias aktiviert ihn in xitl unter Einstellungen, „xitl als Upstream hinzufügen“.
- In der alten Session waren die Tools noch nicht sichtbar, weil die Tool-Liste des Konnektors beim Start geladen wird. Deshalb gibt es diese neue Session.

## Ablauf

1. Prüfen, ob `mcp__claude_ai_XITL_Proxy_All__xitl_list_history` und die anderen beiden Tools da sind (per ToolSearch nach `xitl_`).
   - Fehlen sie: im Code nachsehen, warum der BUILTIN-Upstream nicht im `tools/list` des vereinten `/mcp` auftaucht. Ansatzpunkte sind `upstream/connection.ts` (`contactBuiltin`) und `builtin/server.ts`.
2. `xitl_list_history` mit `pause_check=mismatch`, `from=2026-10-21` aufrufen. Matthias gibt jeden Abruf auf dem Handy frei.
3. Für jeden Fall `xitl_get_history_entry` aufrufen, um `clefInput` zu bekommen.
   - **Ab `v0.16.0`** steht dort exakt das, was Clef gesehen hat (`AuditEntry.pauseCheckInput`).
   - **Vor `v0.16.0`** ist es meist `null`. Gehaltene Mismatch-Zeilen haben kein `pauseSnoozeId`, und abgelaufene Snoozes werden gelöscht (`snooze.ts`). Rekonstruktion von Hand:
     - die früheren Aufrufe desselben Clients und Upstreams auflisten (`list_history` mit `upstream` und Zeitfenster);
     - den Anker finden, also den Aufruf, auf dem die Zeitfreigabe erteilt wurde;
     - den Purpose von der Mismatch-Zeile übernehmen;
     - die Aufrufe dazwischen sammeln (Clef sieht nur die neuesten 8);
     - daraus den Input mit `buildState` aus `apps/api/src/pausecheck/prompt.ts` bauen.
4. Matthias jeden Fall kompakt zeigen: Purpose, Anker, Aufrufe dazwischen, neuer Aufruf, Score. Ihn fragen, ob der Anker stimmt und ob er das als Richtungswechsel sieht, und was er eigentlich wollte.
5. Die Fälle mit seinem Urteil als erwartetes Ergebnis in `scripts/bench/clef_bench.py` bzw. `clef_pause_intent.py` (`CASES`) aufnehmen.
6. Den Bench gegen den echten Clef laufen lassen.
   - Vorher `/health` und `/v1/models` prüfen: Die Scores driften zwischen llama.cpp-Builds.
   - Modell immer per Alias `clef` ansprechen.
7. Erst dann den Hebel vorschlagen und Matthias entscheiden lassen. Optionen:
   - die Schwelle (`gate.ts` `threshold`);
   - der Prompt: Zählt der Purpose als weiter gefasst als der Anker?
   - Anker auf den Purpose statt auf den ersten Aufruf;
   - „nur hinweisen“.

   Das Ergebnis wird ein ADR oder ein Amendment zu ADR-0029.

## Zwischenstand (2026-10-21, Abend)

Die Schritte 1 bis 3 sind erledigt. Es gibt 14 Mismatch-Zeilen (#362 bis #385), alle aus einer Session: den n8n-E-Mail-Draft-Workflow von Ollama auf llama.cpp umstellen, Upstream `n8n-instance-mcp` (Anzeigename „N8N Instance MCP“). Alle Zeilen stammen von vor v0.16.0 (der Tag ist von 20:50 Berliner Zeit), deshalb ist `clefInput` überall `null`.

Alle 14 States sind **bytegenau rekonstruiert**: Der Score gegen den echten Clef stimmt mit dem gespeicherten überein, Δ = 0. Die Rekonstruktion liegt in `data/clef-cases-2026-10-21/` (gitignored). `recon.mts` läuft mit `npx tsx` und nutzt das echte `buildState`, in `matches.json` stehen die States.

Ankerkette:
- #360 `search_workflows` (Zeitfreigabe erteilt) → #362
- #362 bleibt Anker für #363, #367, #369 und #371. Bei #367 also nur „Erlauben“, danach „Fortsetzen“ in „Läuft gerade“.
- Ab #371 wandert der Anker bei jedem „Erlauben & fortsetzen“ auf den gerade freigegebenen Aufruf. Clef vergleicht dann also nur noch Schritt mit Schritt und nicht mehr mit der Aufgabe.

Nebenbefund: „Calls executed since“ enthält auch Aufrufe, die **vor** dem neuen Anker liegen (#361, #375 bis #377), weil die Liste über `pauseSnoozeId` läuft und nicht ab dem Anker. Freigegebene Mismatch-Aufrufe fehlen dort dagegen ganz.

Schritt 4 ist erledigt (Matthias, 2026-10-22): #384 und #385 sollen anhalten (anderer Workflow, die Ausweitung hatte er Claude im Chat bestätigt, Clef wusste davon aber nichts). Alle anderen elf sind ok, auch `publish_workflow` gehört zum Auftrag „umstellen“. Den Zweck hat das `maxlength="200"` im „Wofür?“-Feld beim Einfügen still gekürzt. Er lautete sinngemäß: Ollama ist im Cluster durch llama.cpp abgelöst, den n8n-E-Mail-Draft-Workflow umstellen.

Schritte 5 und 6 sind erledigt: `scripts/bench/clef_purpose_fit.py` (14 synthetische und 13 echte Fälle, Varianten P0/P1/P2, `--full-purpose`). Ergebnis:
- P0 (Produktion) trennt die synthetischen Fälle perfekt (Lücke +0,72), lässt aber 0 von 11 echten ok-Fällen durch.
- Die zweckbezogenen Fragen P1/P2 lassen 1 bis 2 von 11 durch und weichen die synthetischen auf (plan-add-then-remove 0,68 bis 0,73).
- Weder der volle Zweck noch ein fester Anker #360 noch die echte Aufruffolge trennen die echten Fälle (siehe Tabelle im Chat vom 2026-10-22). Lese-Aufrufe wie #379 bekommen teils 0,05.
- Fazit: Clef kann Aufgaben mit mehreren Schritten nicht beurteilen. Das liegt weder an der Schwelle noch am Prompt.

Korrektur einer Annahme: Eine Allow-Pause hebt auch eine explizite ASK-Regel auf (`policy.ts` Schritt 10). Eine Regel „immer fragen, auch bei Zeitfreigabe“ gibt es noch nicht.

Gegenprobe mit Qwen und Reasoning (`scripts/bench/qwen_purpose_fit.py`, Alias `qwen`, ein Lauf mit temperature 0.6, Log in `data/clef-cases-2026-10-21/qwen_run.log`):
- Q0 (Ankerfrage): synthetisch 12/14, echt 6/13.
- Q1 (Zweckfrage): synthetisch 13/14, echt 8/13.
- Q1 lässt ausgerechnet #385 durch (Dedup-Workflow archiviert, „cleanup implied by the purpose“) und ebenso plan-add-then-remove. Lese-Aufrufe (#362, #363, #367, #379) hält es an.
- Median 25 s pro Aufruf, bis zu 58 s. Als blockierende Prüfung taugt das also auch nicht.

Matthias erwägt, Clef aus dem Cluster zu nehmen. Reihenfolge: zuerst `PAUSE_CHECK_URL` im Deployment entfernen, dann Clef. Alle drei Funktionen (ADR-0029, Sperre mit Zweck, AUTO) schalten sich damit sauber ab.

Offen: Matthias entscheidet über den Hebel. Vorschlag: Regel-Option „auch bei Zeitfreigabe fragen“ und Zähler im „Wofür?“-Feld.

## Grenzen

- Die `xitl`-Tools bleiben dauerhaft read-only (ADR-0037 §3). Kein Tool, das Regeln, Freigaben oder Einstellungen ändert.
- Zugriffe (Clients, Tokens) werden nicht abgefragt.
- Ergebnistexte anderer Upstreams kommen nie mit. Das ist Absicht und kein Bug.
- Antworten an Matthias auf Deutsch. Er ist PM, ich bin Tech Lead, gebaut wird mit Sonnet-Subagents.
