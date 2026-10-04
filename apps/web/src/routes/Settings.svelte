<script lang="ts">
  import Spinner from '../lib/Spinner.svelte';
  import ConfirmDialog from '../lib/ConfirmDialog.svelte';
  import UpstreamSheet from '../lib/UpstreamSheet.svelte';
  import { api, messageOf, STATUS_LABEL, type McpClient, type Upstream, type UpstreamInput } from '../lib/api';
  import { showToast } from '../lib/store.svelte';

  let upstreams = $state<Upstream[]>([]);
  let clients = $state<McpClient[]>([]);
  // Whether the server has MCP_TOKEN set (otherwise there are no endpoints to show).
  let mcpConfigured = $state(true);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);

  let renamingId = $state<number | null>(null);
  let draft = $state('');
  let revoking = $state<McpClient | null>(null);
  let copiedSlug = $state<string | null>(null);
  let endpointInputs: Record<string, HTMLInputElement | undefined> = $state({});

  /** The MCP URL of one upstream (ADR-0014). */
  const endpointOf = (u: Upstream) => `${location.origin}/mcp/${u.slug}`;

  // `null` = closed, 'new' = adding, an Upstream = editing it.
  let sheet = $state<Upstream | 'new' | null>(null);
  let deleting = $state<Upstream | null>(null);

  async function load() {
    try {
      const config = await api.getMcpConfig();
      mcpConfigured = config.configured;
      [upstreams, clients] = await Promise.all([
        api.listUpstreams(),
        config.configured ? api.listMcpClients() : Promise.resolve([] as McpClient[]),
      ]);
      loadError = null;
    } catch (e) {
      loadError = messageOf(e);
    } finally {
      loaded = true;
    }
  }
  load();

  async function save(input: UpstreamInput) {
    if (sheet === 'new') {
      await api.createUpstream(input);
      showToast(`„${input.name}“ hinzugefügt`);
    } else if (sheet) {
      await api.updateUpstream(sheet.id, input);
      showToast('Gespeichert');
    }
    sheet = null;
    await load();
  }

  async function copy(u: Upstream, input: HTMLInputElement | undefined) {
    try {
      await navigator.clipboard.writeText(endpointOf(u));
    } catch {
      input?.select(); // clipboard unavailable: leave it selected for a manual copy
      return;
    }
    copiedSlug = u.slug;
    setTimeout(() => (copiedSlug = null), 2000);
  }

  function startRename(c: McpClient) {
    renamingId = c.id;
    draft = c.name;
  }

  async function saveRename(c: McpClient) {
    const name = draft.trim();
    if (renamingId !== c.id) return;
    renamingId = null;
    if (name === '' || name === c.name) return;
    try {
      await api.renameMcpClient(c.id, name);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    }
    await load();
  }

  async function revoke(c: McpClient) {
    revoking = null;
    try {
      await api.revokeMcpClient(c.id);
      showToast(`„${c.name}“ getrennt`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    }
    await load();
  }

  const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

  async function remove(u: Upstream) {
    deleting = null;
    try {
      await api.deleteUpstream(u.id);
      showToast(`„${u.name}“ gelöscht`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    }
    await load();
  }
</script>

<div class="settings">
  <section aria-labelledby="upstreams-title">
    <h2 id="upstreams-title">Upstreams</h2>
    {#if !loaded}
      <Spinner />
    {:else if loadError}
      <p class="error" role="alert">{loadError}</p>
      <button type="button" class="btn" onclick={load}>Erneut versuchen</button>
    {:else}
      {#if upstreams.length === 0}
        <p class="empty">Noch kein Upstream eingetragen.</p>
      {:else}
        <ul class="list" aria-label="Upstreams">
          {#each upstreams as u (u.id)}
            <li class="item" data-slug={u.slug}>
              <div class="item-head">
                <span class="item-name">{u.name}</span>
                <span class="badge status-{u.status.toLowerCase()}">{STATUS_LABEL[u.status]}</span>
              </div>
              <div class="sub">
                <span>{u.slug}</span>
                <span class="url">{u.url}</span>
              </div>
              {#if mcpConfigured}
                <div class="endpoint">
                  <input
                    type="text"
                    readonly
                    value={endpointOf(u)}
                    aria-label={`MCP-Adresse von ${u.name}`}
                    onfocus={(e) => e.currentTarget.select()}
                    bind:this={endpointInputs[u.slug]}
                  />
                  <button
                    type="button"
                    class="btn"
                    aria-label={`Adresse von ${u.name} kopieren`}
                    onclick={() => copy(u, endpointInputs[u.slug])}
                  >
                    {copiedSlug === u.slug ? 'Kopiert' : 'Kopieren'}
                  </button>
                </div>
              {/if}
              <div class="item-actions">
                <button type="button" class="btn" onclick={() => (sheet = u)}>Bearbeiten</button>
                <button type="button" class="btn danger-outline" onclick={() => (deleting = u)}>Löschen</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      <button type="button" class="btn primary wide add-upstream" onclick={() => (sheet = 'new')}>
        Upstream hinzufügen
      </button>
      {#if mcpConfigured}
        <p class="hint endpoint-note">
          Jeder Upstream hat eine eigene Adresse für Claude. Alle Upstreams in einem Endpunkt (/mcp)
          folgt später.
        </p>
      {:else}
        <p class="hint endpoint-note">
          Die Claude-Anbindung ist auf diesem Server nicht eingerichtet. Sie wird aktiv, sobald die
          Umgebungsvariable <code>MCP_TOKEN</code> gesetzt ist.
        </p>
      {/if}
    {/if}
  </section>

  {#if loaded && !loadError && mcpConfigured}
    <section aria-labelledby="clients-title">
      <h2 id="clients-title">MCP-Clients</h2>
      {#if clients.length === 0}
        <p class="empty">Noch kein Client verbunden.</p>
      {:else}
        <ul class="list" aria-label="MCP-Clients">
          {#each clients as c (c.id)}
            <li class="item">
              {#if renamingId === c.id}
                <form
                  class="rename-row"
                  onsubmit={(e) => {
                    e.preventDefault();
                    saveRename(c);
                  }}
                >
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    type="text"
                    aria-label="Name des Clients"
                    maxlength="100"
                    bind:value={draft}
                    autofocus
                    onkeydown={(e) => e.key === 'Escape' && (renamingId = null)}
                  />
                  <button type="submit" class="btn primary">Speichern</button>
                </form>
              {:else}
                <div class="item-name">{c.name}</div>
                <div class="sub">
                  <span>verbunden seit {date.format(new Date(c.createdAt))}</span>
                  <span>
                    {c.lastUsedAt
                      ? `zuletzt benutzt ${dateTime.format(new Date(c.lastUsedAt))}`
                      : 'noch nie benutzt'}
                  </span>
                </div>
                <div class="item-actions">
                  <button type="button" class="btn" onclick={() => startRename(c)}>Umbenennen</button>
                  <button type="button" class="btn danger-outline" onclick={() => (revoking = c)}>Trennen</button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

{#if revoking}
  {@const target = revoking}
  <ConfirmDialog
    title={`„${target.name}“ trennen?`}
    message="Dieser Client verliert sofort den Zugriff. Er kann sich jederzeit neu verbinden."
    confirmLabel="Trennen"
    onconfirm={() => revoke(target)}
    oncancel={() => (revoking = null)}
  />
{/if}

{#if sheet}
  <UpstreamSheet upstream={sheet === 'new' ? undefined : sheet} onclose={() => (sheet = null)} onsave={save} />
{/if}

{#if deleting}
  {@const target = deleting}
  <ConfirmDialog
    title={`„${target.name}“ löschen?`}
    message="Der Upstream und seine Verbindung werden entfernt. Das lässt sich nicht rückgängig machen."
    confirmLabel="Löschen"
    onconfirm={() => remove(target)}
    oncancel={() => (deleting = null)}
  />
{/if}
