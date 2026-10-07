<script lang="ts">
  // ADR-0029 (and ADR-0030, same Clef): the AI check failed. Like an upstream "Störung"
  // (FaultCard, ADR-0022): not an approval, no deadline. Until the next
  // successful check, paused calls are asked again. The button turns the
  // user's check off (PATCH /api/me); the server then clears the card.
  import { api, messageOf } from './api';
  import { showToast } from './store.svelte';

  let { onoff }: { onoff?: () => void } = $props();
  let busy = $state(false);

  async function turnOff() {
    busy = true;
    try {
      await api.setPauseCheck(false);
      showToast('KI-Prüfung ausgeschaltet – Zeitfreigaben gelten wieder ohne Prüfung');
      onoff?.();
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
    }
  }
</script>

<article class="fault card" data-pausecheck-fault aria-label="Störung: KI-Prüfung">
  <div class="fault-head">
    <span class="fault-label">Störung</span>
  </div>
  <p class="fault-name">KI-Prüfung nicht erreichbar – Zeitfreigaben fragen wieder nach</p>
  <p class="fault-state">
    Aufrufe unter einer Zeitfreigabe und mit Auto-Regel werden bis dahin zur Freigabe vorgelegt.
    Ausschalten lässt die Zeitfreigaben wieder ohne Prüfung gelten; „Auto“ fragt dann wie „Fragen“
    (auch in den Einstellungen).
  </p>
  <button type="button" class="btn wide" disabled={busy} onclick={turnOff}>
    {busy ? 'Schalte aus…' : 'KI-Prüfung ausschalten'}
  </button>
</article>

<style>
  .fault {
    border-color: var(--warn);
    background: var(--warn-soft);
    margin-bottom: 0.75rem;
  }
  .fault-head {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.25rem;
  }
  .fault-label {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--warn);
  }
  .card .fault-name {
    margin: 0 0 0.25rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .card .fault-state {
    color: var(--fg);
  }
  .fault .btn {
    border-color: var(--warn);
    color: var(--warn);
    background: var(--surface);
  }
</style>
