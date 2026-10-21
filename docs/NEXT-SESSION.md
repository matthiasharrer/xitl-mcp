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

Offen: Schritt 4, Matthias' Urteil pro Fall.

## Grenzen

- Die `xitl`-Tools bleiben dauerhaft read-only (ADR-0037 §3). Kein Tool, das Regeln, Freigaben oder Einstellungen ändert.
- Zugriffe (Clients, Tokens) werden nicht abgefragt.
- Ergebnistexte anderer Upstreams kommen nie mit. Das ist Absicht und kein Bug.
- Antworten an Matthias auf Deutsch. Er ist PM, ich bin Tech Lead, gebaut wird mit Sonnet-Subagents.
