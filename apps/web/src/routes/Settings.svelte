<script lang="ts">
  import Spinner from '../lib/Spinner.svelte';
  import ConfirmDialog from '../lib/ConfirmDialog.svelte';
  import UpstreamSheet from '../lib/UpstreamSheet.svelte';
  import TokenSheet from '../lib/TokenSheet.svelte';
  import { api, ApiError, messageOf, STATUS_LABEL, type McpClient, type Upstream, type UpstreamInput } from '../lib/api';
  import { showToast } from '../lib/store.svelte';
  import {
    currentSubscription,
    pushPermission,
    pushSupported,
    sendTestPush,
    subscribeThisDevice,
    unsubscribeThisDevice,
  } from '../lib/push';

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
  /** All upstreams in one (ADR-0017). `*` is never a slug. */
  const UNIFIED = '*';
  const unifiedEndpoint = `${location.origin}/mcp`;

  // `null` = closed, 'new' = adding, an Upstream = editing it.
  let sheet = $state<Upstream | 'new' | null>(null);
  let deleting = $state<Upstream | null>(null);
  /** Token dialog: for one upstream, for all (`'all'`), or closed (null). */
  let tokenFor = $state<Upstream | 'all' | null>(null);

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
  // One-shot result of the upstream OAuth callback (GET
  // /api/upstreams/oauth/callback redirects to #/einstellungen?…): show it,
  // then drop it from the URL so a reload doesn't repeat it.
  async function showConnectResult() {
    const query = location.hash.split('?')[1];
    if (!query) return;
    const params = new URLSearchParams(query);
    history.replaceState(null, '', '#/einstellungen');
    await load();
    const connected = Number(params.get('verbunden'));
    const failed = params.get('verbindung');
    const name = (id: number) => upstreams.find((u) => u.id === id)?.name ?? 'Upstream';
    if (connected) showToast(`„${name(connected)}“ verbunden`);
    else if (failed === 'abgelehnt') showToast(`Verbindung zu „${name(Number(params.get('upstream')))}“ wurde abgelehnt.`, { error: true });
    else if (failed) showToast(`Verbindung zu „${name(Number(params.get('upstream')))}“ ist fehlgeschlagen.`, { error: true });
  }

  if (location.hash.includes('?')) showConnectResult();
  else load();

  let connectingId = $state<number | null>(null);

  async function connect(u: Upstream) {
    connectingId = u.id;
    try {
      const { authorizationUrl } = await api.connectUpstream(u.id);
      // Off to the upstream's own login/consent page; it sends the browser back
      // to /api/upstreams/oauth/callback, which lands here again.
      location.assign(authorizationUrl);
    } catch (e) {
      connectingId = null;
      showToast(messageOf(e), { error: true });
    }
  }

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

  /** Copies an endpoint URL; `key` is the upstream slug, or UNIFIED. */
  async function copy(key: string, url: string, input: HTMLInputElement | undefined) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      input?.select(); // clipboard unavailable: leave it selected for a manual copy
      return;
    }
    copiedSlug = key;
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

  // ---- Benachrichtigungen (ADR-0009, copied from haushalts-todos) ----
  const supported = pushSupported();
  let permission = $state<NotificationPermission>(pushPermission());
  let deviceOn = $state(false);
  let deviceBusy = $state(false);
  let testing = $state(false);

  async function loadDevice() {
    if (!supported) return;
    try {
      deviceOn = pushPermission() === 'granted' && (await currentSubscription()) !== null;
    } catch {
      deviceOn = false;
    }
  }
  loadDevice();

  async function toggleDevice(on: boolean) {
    deviceBusy = true;
    try {
      if (on) {
        await subscribeThisDevice();
        deviceOn = true;
        showToast('Benachrichtigungen auf diesem Gerät aktiv');
      } else {
        await unsubscribeThisDevice();
        deviceOn = false;
      }
    } catch (e) {
      deviceOn = !on;
      if (!(e instanceof Error && e.message === 'permission-denied')) {
        showToast(e instanceof ApiError ? e.message : 'Anmelden beim Push-Dienst hat nicht geklappt.', { error: true });
      }
    } finally {
      permission = pushPermission();
      deviceBusy = false;
    }
  }

  async function testPush() {
    testing = true;
    try {
      await sendTestPush();
      showToast('Test gesendet');
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      testing = false;
    }
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
  <section aria-labelledby="notif-title">
    <h2 id="notif-title">Benachrichtigungen</h2>
    <div class="card">
      {#if !supported}
        <p class="hint">
          Dieser Browser kann keine Push-Nachrichten empfangen. Auf dem Android-Handy geht es in
          Chrome; auf dem iPhone muss xitl erst zum Home-Bildschirm hinzugefügt werden (Teilen →
          „Zum Home-Bildschirm“) und von dort geöffnet werden.
        </p>
      {:else}
        <label class="switch-row">
          <input
            type="checkbox"
            checked={deviceOn}
            disabled={deviceBusy || permission === 'denied'}
            onchange={(e) => toggleDevice(e.currentTarget.checked)}
          />
          <span>Benachrichtigungen auf diesem Gerät</span>
        </label>
        {#if permission === 'denied'}
          <p class="hint">
            Benachrichtigungen sind für diese Seite blockiert. In Chrome: Schloss-Symbol neben der
            Adresse → Berechtigungen → Benachrichtigungen → Zulassen. Danach diese Seite neu laden.
          </p>
        {:else if deviceOn}
          <div class="notif-actions">
            <button type="button" class="btn" disabled={testing} onclick={testPush}>Test-Push senden</button>
          </div>
        {/if}
        <p class="hint">
          Jede Freigabe kommt sofort als Benachrichtigung. Auf Android lässt sie sich direkt dort
          erlauben oder ablehnen; auf dem iPhone öffnet ein Tippen die Freigabe in der App.
        </p>
      {/if}
    </div>
  </section>

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
        {#if mcpConfigured}
          <ul class="list unified" aria-label="Alle Upstreams">
          <li class="item">
            <div class="item-head">
              <span class="item-name">Alle Upstreams</span>
            </div>
            <div class="endpoint">
              <input
                type="text"
                readonly
                value={unifiedEndpoint}
                aria-label="MCP-Adresse für alle Upstreams"
                onfocus={(e) => e.currentTarget.select()}
                bind:this={endpointInputs[UNIFIED]}
              />
              <button
                type="button"
                class="btn"
                aria-label="Adresse für alle Upstreams kopieren"
                onclick={() => copy(UNIFIED, unifiedEndpoint, endpointInputs[UNIFIED])}
              >
                {copiedSlug === UNIFIED ? 'Kopiert' : 'Kopieren'}
              </button>
            </div>
            <p class="hint">
              Ein Konnektor für alle Upstreams; Tool-Namen beginnen mit dem Kürzel (z. B.
              <code>{upstreams[0]!.slug}_…</code>). Funktioniert mit der Claude-Anmeldung oder einem
              Token für alle Upstreams, nicht mit dem Token eines einzelnen Upstreams.
            </p>
            <div class="item-actions">
              <button type="button" class="btn" aria-label="Token für alle Upstreams erstellen" onclick={() => (tokenFor = 'all')}>
                Token erstellen
              </button>
            </div>
          </li>
          </ul>
        {/if}
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
                    onclick={() => copy(u.slug, endpointOf(u), endpointInputs[u.slug])}
                  >
                    {copiedSlug === u.slug ? 'Kopiert' : 'Kopieren'}
                  </button>
                </div>
              {/if}
              {#if u.status === 'NEEDS_RECONNECT'}
                <p class="hint reconnect-note">Die Anmeldung ist abgelaufen. Claude erreicht diesen Upstream erst wieder nach „Neu verbinden“.</p>
              {/if}
              <div class="item-actions">
                {#if u.auth === 'OAUTH'}
                  <button
                    type="button"
                    class="btn"
                    class:primary={u.status !== 'CONNECTED'}
                    disabled={connectingId !== null}
                    onclick={() => connect(u)}
                  >
                    {connectingId === u.id ? 'Verbinde…' : u.status === 'NOT_CONNECTED' ? 'Verbinden' : 'Neu verbinden'}
                  </button>
                {/if}
                <a class="btn" href={`#/regeln/${u.id}`} aria-label={`Regeln für ${u.name}`}>Regeln</a>
              </div>
              {#if mcpConfigured}
                <div class="item-actions">
                  <button type="button" class="btn" aria-label={`Token für ${u.name} erstellen`} onclick={() => (tokenFor = u)}>
                    Token erstellen
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
          Jeder Upstream hat eine eigene Adresse für Claude; „Alle Upstreams“ bündelt sie in einem
          Konnektor. Regeln und Freigaben gelten für beide gleich.
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
                <div class="item-head">
                  <span class="item-name">{c.name}</span>
                  <span class="badge" class:kind-token={c.kind === 'TOKEN'}>
                    {c.kind === 'TOKEN' ? (c.allUpstreams ? 'Token für alle Upstreams' : `Token für ${c.upstream?.name ?? 'Upstream'}`) : 'OAuth'}
                  </span>
                </div>
                <div class="sub">
                  {#if c.kind === 'TOKEN' && c.tokenPrefix}
                    <span class="url" data-testid="token-prefix">{c.tokenPrefix}…</span>
                  {/if}
                  <span>{c.kind === 'TOKEN' ? 'erstellt' : 'verbunden seit'} {date.format(new Date(c.createdAt))}</span>
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

    <section aria-labelledby="sessions-title">
      <h2 id="sessions-title">Sitzungen</h2>
      <a class="btn wide" href="#/sitzungen">Sitzungen ansehen</a>
      <p class="hint section-hint">Welcher Client wann eine Sitzung geöffnet hat und welche Aufrufe dazugehören.</p>
    </section>
  {/if}
</div>

{#if revoking}
  {@const target = revoking}
  <ConfirmDialog
    title={`„${target.name}“ trennen?`}
    message={target.kind === 'TOKEN'
      ? 'Dieses Token funktioniert sofort nicht mehr. Wartende Freigaben werden abgelehnt. Das lässt sich nicht rückgängig machen.'
      : 'Dieser Client verliert sofort den Zugriff. Er kann sich jederzeit neu verbinden.'}
    confirmLabel="Trennen"
    onconfirm={() => revoke(target)}
    oncancel={() => (revoking = null)}
  />
{/if}

{#if sheet}
  <UpstreamSheet upstream={sheet === 'new' ? undefined : sheet} onclose={() => (sheet = null)} onsave={save} />
{/if}

{#if tokenFor}
  <TokenSheet upstream={tokenFor === 'all' ? null : tokenFor} onclose={() => (tokenFor = null)} oncreated={load} />
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
