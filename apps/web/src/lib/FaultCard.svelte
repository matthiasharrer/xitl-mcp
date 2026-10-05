<script lang="ts">
  // One upstream that needs the user (ADR-0022): a "Störung", not an approval
  // (no Erlauben/Ablehnen, no deadline). "Erneut prüfen" re-lists the tools (a
  // contact that sets or clears the state; the stream then removes the card),
  // "Neu verbinden" starts the OAuth connect flow as in Einstellungen.
  import { api, messageOf, type UpstreamFault } from './api';
  import { showToast } from './store.svelte';

  let { fault, onchange }: { fault: UpstreamFault; onchange?: () => void } = $props();

  let busy = $state(false);

  const sinceText = $derived.by(() => {
    if (!fault.since) return '';
    const d = new Date(fault.since);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return sameDay ? `${time} Uhr` : `${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}, ${time} Uhr`;
  });

  async function recheck() {
    busy = true;
    try {
      await api.refreshTools(fault.id);
      showToast(`„${fault.name}“ ist wieder erreichbar`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
      onchange?.();
    }
  }

  async function reconnect() {
    busy = true;
    try {
      const { authorizationUrl } = await api.connectUpstream(fault.id);
      // The upstream's login page sends the browser back to Einstellungen.
      location.assign(authorizationUrl);
    } catch (e) {
      busy = false;
      showToast(messageOf(e), { error: true });
    }
  }
</script>

<article class="fault card" data-fault={fault.id} aria-label={`Störung: ${fault.name}`}>
  <div class="fault-head">
    <span class="fault-label">Störung</span>
  </div>
  <p class="fault-name">{fault.name}</p>
  {#if fault.state === 'reconnect'}
    <p class="fault-state">muss neu verbunden werden. Bis dahin sieht Claude keine Tools davon.</p>
    <button type="button" class="btn primary wide" disabled={busy} onclick={reconnect}>
      {busy ? 'Verbinde…' : 'Neu verbinden'}
    </button>
  {:else}
    <p class="fault-state">{`nicht erreichbar${sinceText ? ` seit ${sinceText}` : ''}. Claude sieht seine Tools gerade nicht.`}</p>
    <button type="button" class="btn wide" disabled={busy} onclick={recheck}>
      {busy ? 'Prüfe…' : 'Erneut prüfen'}
    </button>
  {/if}
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
  .fault .btn:not(.primary) {
    border-color: var(--warn);
    color: var(--warn);
    background: var(--surface);
  }
</style>
