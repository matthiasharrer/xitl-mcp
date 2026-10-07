<script lang="ts">
  // One MCP client's own page (Einstellungen rework, 2026-10-07): the
  // "Aktiv" switch (= not paused, ADR-0024), what it is and sees (ADR-0032),
  // and the rare actions: Umbenennen, Web-Adressen (tokens, ADR-0023),
  // Trennen. The list on Einstellungen only shows the switch and the name.
  import Spinner from '../lib/Spinner.svelte';
  import Switch from '../lib/Switch.svelte';
  import ConfirmDialog from '../lib/ConfirmDialog.svelte';
  import OriginsSheet from '../lib/OriginsSheet.svelte';
  import { api, messageOf, type McpClient } from '../lib/api';
  import { showToast } from '../lib/store.svelte';
  import { clientKind } from '../lib/clients';

  let { id }: { id: number } = $props();

  let client = $state<McpClient | null>(null);
  /** true when the client isn't (or no longer) in the user's list. */
  let gone = $state(false);
  let loadError = $state<string | null>(null);
  let busy = $state(false);

  async function load() {
    try {
      // The list carries `sees` / `hidden` (ADR-0032); there is no single GET.
      const all = await api.listMcpClients();
      client = all.find((c) => c.id === id) ?? null;
      gone = client === null;
      loadError = null;
    } catch (e) {
      loadError = messageOf(e);
    }
  }
  load();

  const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

  async function setPaused(paused: boolean) {
    if (!client) return;
    const name = client.name;
    busy = true;
    try {
      await api.setClientPaused(id, paused);
      showToast(paused ? `„${name}“ pausiert` : `„${name}“ fortgesetzt`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
      await load();
    }
  }

  let renaming = $state(false);
  let draft = $state('');
  function startRename() {
    if (!client) return;
    draft = client.name;
    renaming = true;
  }
  async function saveRename() {
    if (!client || !renaming) return;
    const name = draft.trim();
    renaming = false;
    if (name === '' || name === client.name) return;
    try {
      await api.renameMcpClient(id, name);
      showToast('Umbenannt');
    } catch (e) {
      showToast(messageOf(e), { error: true });
    }
    await load();
  }

  let originsOpen = $state(false);
  let revoking = $state(false);

  async function revoke() {
    if (!client) return;
    const name = client.name;
    revoking = false;
    try {
      await api.revokeMcpClient(id);
      showToast(`„${name}“ getrennt`);
      location.hash = '#/einstellungen';
    } catch (e) {
      showToast(messageOf(e), { error: true });
      await load();
    }
  }
</script>

<div class="rules client-page">
  <a class="back-link" href="#/einstellungen">‹ Einstellungen</a>

  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
    <button type="button" class="btn" onclick={load}>Erneut versuchen</button>
  {:else if gone}
    <p class="empty">Diesen Client gibt es nicht mehr.</p>
  {:else if !client}
    <Spinner />
  {:else}
    {@const c = client}
    {#if renaming}
      <form
        class="rename-row"
        onsubmit={(e) => {
          e.preventDefault();
          saveRename();
        }}
      >
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          aria-label="Name des Clients"
          maxlength="100"
          bind:value={draft}
          autofocus
          onkeydown={(e) => e.key === 'Escape' && (renaming = false)}
        />
        <button type="submit" class="btn primary">Speichern</button>
      </form>
    {:else}
      <div class="detail-head">
        <h2 class="rules-title">{c.name}</h2>
        {#if c.pausedAt}<span class="chip paused" data-testid="client-paused">pausiert</span>{/if}
        <span class="badge" class:kind-token={c.kind === 'TOKEN'}>{clientKind(c)}</span>
      </div>
    {/if}

    <div class="card general" data-testid="client-general">
      <div class="active-row">
        <span class="active-text">
          <span class="active-title">Aktiv</span>
          <span class="hint">
            {c.pausedAt
              ? `Pausiert seit ${dateTime.format(new Date(c.pausedAt))}: Anfragen werden abgewiesen.`
              : 'Darf Tools auflisten und aufrufen.'}
          </span>
        </span>
        <Switch checked={c.pausedAt === null} label={`Aktiv: ${c.name}`} disabled={busy} onchange={(on) => setPaused(!on)} />
      </div>
      <div class="sep"></div>
      <div class="facts">
        {#if c.kind === 'TOKEN' && c.tokenPrefix}
          <span class="url" data-testid="token-prefix">{c.tokenPrefix}…</span>
        {/if}
        <span>{c.kind === 'TOKEN' ? 'erstellt' : 'verbunden seit'} {date.format(new Date(c.createdAt))}</span>
        <span>{c.lastUsedAt ? `zuletzt benutzt ${dateTime.format(new Date(c.lastUsedAt))}` : 'noch nie benutzt'}</span>
        {#if c.sees && c.hidden && c.sees.length + c.hidden.length > 0}
          <!-- ADR-0032: hidden = Voreinstellung "Verbieten" in the upstream's rules. -->
          <span data-testid="client-sees"
            >Sieht: {c.sees.length > 0 ? c.sees.join(', ') : 'nichts'}{#if c.hidden.length > 0}{' '}· Verborgen: {c.hidden.join(', ')}{/if}</span
          >
        {/if}
        {#if c.kind === 'TOKEN' && c.allowedOrigins.length > 0}
          <span data-testid="token-origins">Im Browser erlaubt: {c.allowedOrigins.join(', ')}</span>
        {/if}
      </div>
      <div class="item-actions">
        <button type="button" class="btn" onclick={startRename}>Umbenennen</button>
        <button type="button" class="btn danger-outline" onclick={() => (revoking = true)}>Trennen</button>
      </div>
      {#if c.kind === 'TOKEN'}
        <button type="button" class="btn wide" onclick={() => (originsOpen = true)}>Web-Adressen bearbeiten</button>
      {/if}
    </div>
  {/if}
</div>

{#if revoking && client}
  {@const target = client}
  <ConfirmDialog
    title={`„${target.name}“ trennen?`}
    message={target.kind === 'TOKEN'
      ? 'Dieses Token funktioniert sofort nicht mehr. Wartende Freigaben werden abgelehnt. Das lässt sich nicht rückgängig machen.'
      : 'Dieser Client verliert sofort den Zugriff. Er kann sich jederzeit neu verbinden.'}
    confirmLabel="Trennen"
    onconfirm={revoke}
    oncancel={() => (revoking = false)}
  />
{/if}

{#if originsOpen && client}
  <OriginsSheet
    client={client}
    onclose={() => (originsOpen = false)}
    onsaved={async () => {
      originsOpen = false;
      showToast('Web-Adressen gespeichert');
      await load();
    }}
  />
{/if}

<style>
  .detail-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
  }
  .detail-head .rules-title {
    margin: 0;
  }
  .general {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.75rem 0 1.25rem;
  }
  .general .item-actions {
    margin-top: 0;
  }
  .active-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .active-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .active-title {
    font-weight: 600;
  }
  .sep {
    margin: 0.25rem calc(-1 * var(--gutter));
    border-top: 1px solid var(--border);
  }
  .facts {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    font-size: 0.8125rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .chip.paused {
    color: var(--warn);
    border-color: var(--warn);
    background: var(--warn-soft);
    font-weight: 600;
  }
</style>
