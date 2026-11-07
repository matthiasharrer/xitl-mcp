<script lang="ts">
  // TC-281/282 (Matthias 2026-11-07): start a Zeitfreigabe from Freigaben
  // before any call is held. Every tool of one upstream, for one access, for
  // 15 min / 1 h / until midnight. No "Wofür?": without a held call there is
  // no anchor, so no KI-Prüfung (ADR-0041). Mounted with {#if}, like
  // ConfirmDialog.
  import { onMount } from 'svelte';
  import { api, messageOf, type PauseDuration, type PauseTarget } from './api';
  import { showToast } from './store.svelte';

  let { ondone, oncancel }: { ondone: () => void; oncancel: () => void } = $props();

  const durations: { value: string; label: string; toast: string; body: PauseDuration }[] = [
    { value: '15', label: '15 Min.', toast: '15 Minuten', body: { snoozeMinutes: 15 } },
    { value: '60', label: '1 Std.', toast: '1 Stunde', body: { snoozeMinutes: 60 } },
    { value: 'midnight', label: 'bis Mitternacht', toast: 'heute', body: { snoozeUntilMidnight: true } },
  ];

  let dialog: HTMLDialogElement;
  onMount(() => dialog.showModal());

  let targets = $state<PauseTarget[] | null>(null);
  let loadError = $state<string | null>(null);
  let upstreamId = $state<number | null>(null);
  let clientId = $state<number | null>(null);
  let duration = $state('15');
  let busy = $state(false);

  api.pauseTargets().then(
    (t) => {
      targets = t;
      upstreamId = t[0]?.id ?? null;
    },
    (e) => (loadError = messageOf(e)),
  );

  const upstream = $derived(targets?.find((t) => t.id === upstreamId) ?? null);
  // A new upstream picks its first access; keep the choice when it still fits.
  $effect(() => {
    const clients = upstream?.clients ?? [];
    if (!clients.some((c) => c.id === clientId)) clientId = clients[0]?.id ?? null;
  });

  async function start() {
    if (upstream === null || clientId === null) return;
    const d = durations.find((x) => x.value === duration) ?? durations[0];
    busy = true;
    try {
      await api.startPause(upstream.id, clientId, d.body);
      showToast(`Zeitfreigabe für ${upstream.name} läuft (${d.toast})`);
      ondone();
    } catch (e) {
      showToast(messageOf(e), { error: true });
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="confirm new-pause"
  aria-labelledby="new-pause-title"
  data-testid="new-pause"
  oncancel={(e) => {
    e.preventDefault();
    oncancel();
  }}
  onclick={(e) => {
    if (e.target === dialog) oncancel();
  }}
>
  <h2 id="new-pause-title">Neue Zeitfreigabe</h2>
  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
  {:else if targets === null}
    <p>Lade…</p>
  {:else if targets.length === 0}
    <p>Noch kein Upstream angelegt.</p>
  {:else}
    <div class="new-pause-fields">
      <label class="field">
        <span class="label">Upstream</span>
        <select bind:value={upstreamId} data-testid="new-pause-upstream">
          {#each targets as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
      </label>
      {#if upstream && upstream.clients.length === 0}
        <p class="hint" data-testid="new-pause-no-client">Noch kein Zugang erreicht diesen Upstream.</p>
      {:else if upstream}
        <label class="field">
          <span class="label">Zugang</span>
          <select bind:value={clientId} data-testid="new-pause-client">
            {#each upstream.clients as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          </select>
        </label>
      {/if}
      <fieldset class="field">
        <legend class="label">Dauer</legend>
        <div class="segmented">
          {#each durations as d (d.value)}
            <label class:selected={duration === d.value}>
              <input type="radio" name="new-pause-duration" value={d.value} bind:group={duration} />
              {d.label}
            </label>
          {/each}
        </div>
      </fieldset>
      <p class="hint" data-testid="new-pause-hint">
        Gilt für alle Tools des Upstreams, die sonst fragen. Neue oder geänderte Tools fragen weiter. Ohne KI-Prüfung.
      </p>
    </div>
  {/if}
  <div class="confirm-actions">
    <button type="button" class="btn" onclick={oncancel}>Abbrechen</button>
    <button type="button" class="btn primary" disabled={busy || upstream === null || clientId === null} onclick={start}>Starten</button>
  </div>
</dialog>

<style>
  .new-pause-fields {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  select {
    width: 100%;
    min-height: var(--tap);
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
  }
  .segmented label {
    font-size: 0.875rem;
  }
</style>
