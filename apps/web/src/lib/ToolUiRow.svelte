<script lang="ts">
  // ADR-0038 (TC-251): a tool's MCP Apps view on its Regeln card. One switch
  // "Oberfläche anzeigen" (on = read the page now and acknowledge it, in the
  // API), the state, what the page may connect to (its CSP, as the upstream
  // declares it; the host enforces it), which tools share the page, and
  // "Nur für die Oberfläche" for a view-only tool. A changed page offers
  // "Neue Version anzeigen" (the switch stays as it is). Display only besides
  // the two callbacks; upstream text is shown as text.
  import Switch from './Switch.svelte';
  import type { ToolRow, ToolUi } from './api';

  let {
    tool,
    ui,
    busy,
    ontoggle,
    onacknowledge,
  }: { tool: ToolRow; ui: ToolUi; busy: boolean; ontoggle: (on: boolean) => void; onacknowledge: () => void } = $props();

  const STATE_LABEL: Record<ToolUi['state'], string> = {
    new: 'Neu',
    shown: 'Wird angezeigt',
    off: 'Aus',
    changed: 'Geändert',
    unreadable: 'Nicht ladbar',
  };

  const connects = $derived(ui.csp?.connectDomains ?? []);
  const loads = $derived(ui.csp?.resourceDomains ?? []);
  const asks = $derived(ui.csp?.permissions ?? []);
</script>

<div class="ui" data-testid="tool-ui" data-ui-state={ui.uri ? ui.state : 'none'}>
  {#if ui.appOnly}
    <p class="app-only"><span class="chip app-only-chip">Nur für die Oberfläche</span> Nur aufrufbar, solange eine Oberfläche dieses Upstreams angezeigt wird.</p>
  {/if}
  {#if ui.uri}
    <div class="ui-head">
      <span class="ui-title">Oberfläche</span>
      <span class="chip ui-state {ui.state}" data-testid="ui-state">{STATE_LABEL[ui.state]}</span>
      <span class="grow"></span>
      <Switch checked={ui.enabled} label={`Oberfläche anzeigen: ${tool.name}`} disabled={busy} onchange={ontoggle} />
    </div>
    {#if ui.state === 'new'}
      <p class="hint">Einschalten lädt die Oberfläche jetzt vom Upstream und zeigt genau diese Fassung an.</p>
    {:else if ui.state === 'changed'}
      <p class="hint changed">Die Oberfläche hat sich seit deiner Freigabe geändert und wird nicht angezeigt.</p>
      <button type="button" class="btn wide" disabled={busy} onclick={onacknowledge}>Neue Version anzeigen</button>
    {:else if ui.state === 'unreadable'}
      <p class="hint">Der Upstream hat die Oberfläche nicht geliefert (oder in falscher Form).</p>
    {/if}
    {#if ui.read}
      <p class="hint csp" data-testid="ui-csp">
        {#if connects.length > 0}Darf verbinden mit: {connects.join(', ')}{:else}Keine externen Verbindungen{/if}
      </p>
      {#if loads.length > 0}<p class="hint csp">Lädt Inhalte von: {loads.join(', ')}</p>{/if}
      {#if asks.length > 0}<p class="hint csp">Fragt nach: {asks.join(', ')}</p>{/if}
    {/if}
    {#if ui.sharedWith.length > 0}
      <p class="hint" data-testid="ui-shared">Gleiche Oberfläche wie: {ui.sharedWith.join(', ')}</p>
    {/if}
  {/if}
</div>

<style>
  .ui {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .ui-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--tap);
  }
  .ui-title {
    font-weight: 600;
  }
  .grow {
    flex: 1;
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .hint.changed {
    color: var(--warn);
  }
  .chip.ui-state.shown {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .chip.ui-state.changed,
  .chip.ui-state.unreadable {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .app-only {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .app-only-chip {
    margin-right: 4px;
  }
</style>
