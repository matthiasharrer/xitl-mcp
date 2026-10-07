<script lang="ts">
  import Spinner from '../lib/Spinner.svelte';
  import UpstreamSheet from '../lib/UpstreamSheet.svelte';
  import TokenSheet from '../lib/TokenSheet.svelte';
  import { clientKind } from '../lib/clients';
  import Switch from '../lib/Switch.svelte';
  import { copyText } from '../lib/clipboard';
  import { api, ApiError, messageOf, STATUS_LABEL, type McpClient, type Me, type Upstream, type UpstreamInput } from '../lib/api';
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

  let unifiedCopied = $state(false);
  let unifiedShown = $state(false);

  /** All upstreams in one (ADR-0017). A single upstream's address, token,
   * editing and deleting live on its own page (Rules.svelte). */
  const unifiedEndpoint = `${location.origin}/mcp`;

  // `null` = closed, 'new' = adding (editing lives on the upstream's page).
  let sheet = $state<'new' | null>(null);
  /** Token dialog for all upstreams (`'all'`), or closed (null). */
  let tokenFor = $state<'all' | null>(null);
  /** The running build (APP_VERSION from CI: `0.3.1`, `main`, or `dev`). */
  let version = $state<string | null>(null);
  api.getHealth().then((h) => (version = h.version), () => undefined);
  /** ADR-0029: the user's "KI-Prüfung für Zeitfreigaben" (shown only when
   * the server has the check configured). */
  let me = $state<Me | null>(null);
  let checkBusy = $state(false);
  api.me().then((m) => (me = m), () => undefined);
  async function togglePauseCheck(on: boolean) {
    checkBusy = true;
    try {
      me = await api.setPauseCheck(on);
      showToast(on ? 'KI-Prüfung eingeschaltet' : 'KI-Prüfung ausgeschaltet');
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      checkBusy = false;
    }
  }
  const versionLabel = $derived(version && /^\d/.test(version) ? `v${version}` : version);

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

  /** ADR-0022: connected, but the last contact failed. */
  const unreachable = (u: Upstream) => u.status === 'CONNECTED' && u.lastFailureAt !== null;
  /** The one action a row offers, only when something needs doing (a paused
   * upstream has none: its switch is the way back). */
  function fixOf(u: Upstream): 'connect' | 'recheck' | null {
    if (u.pausedAt) return null;
    if (u.auth === 'OAUTH' && u.status !== 'CONNECTED') return 'connect';
    return unreachable(u) ? 'recheck' : null;
  }

  let rechecking = $state<number | null>(null);

  /** Re-lists the upstream's tools: a contact that sets or clears the state. */
  async function recheck(u: Upstream) {
    rechecking = u.id;
    try {
      await api.refreshTools(u.id);
      showToast(`„${u.name}“ ist wieder erreichbar`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      rechecking = null;
      await load();
    }
  }

  async function save(input: UpstreamInput) {
    await api.createUpstream(input);
    showToast(`„${input.name}“ hinzugefügt`);
    sheet = null;
    await load();
  }

  async function copyUnified() {
    if (await copyText(unifiedEndpoint)) {
      unifiedCopied = true;
      setTimeout(() => (unifiedCopied = false), 2000);
    } else {
      unifiedShown = true; // clipboard unavailable: show it for a manual copy
    }
  }

  /** ADR-0033: the upstream whose pause/resume request is in flight. */
  let pausingUpstreamId = $state<number | null>(null);

  async function setUpstreamPaused(u: Upstream, paused: boolean) {
    if (pausingUpstreamId !== null) return;
    pausingUpstreamId = u.id;
    try {
      await api.setUpstreamPaused(u.id, paused);
      showToast(paused ? `„${u.name}“ pausiert` : `„${u.name}“ fortgesetzt`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      pausingUpstreamId = null;
    }
    await load();
  }

  /** ADR-0024: the client whose pause/resume request is in flight. */
  let pausingId = $state<number | null>(null);

  async function setPaused(c: McpClient, paused: boolean) {
    if (pausingId !== null) return;
    pausingId = c.id;
    try {
      await api.setClientPaused(c.id, paused);
      showToast(paused ? `„${c.name}“ pausiert` : `„${c.name}“ fortgesetzt`);
    } catch (e) {
      // The API's 404 text is English ("not found"): the client was revoked meanwhile.
      const gone = e instanceof ApiError && e.status === 404;
      showToast(gone ? `„${c.name}“ gibt es nicht mehr.` : messageOf(e), { error: true });
    } finally {
      pausingId = null;
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

  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

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

  {#if me?.pauseCheckAvailable}
    <section aria-labelledby="pausecheck-title">
      <h2 id="pausecheck-title">KI-Prüfung</h2>
      <div class="card">
        <label class="switch-row">
          <input
            type="checkbox"
            checked={me.pauseCheck}
            disabled={checkBusy}
            onchange={(e) => togglePauseCheck(e.currentTarget.checked)}
          />
          <span>KI-Prüfung (Clef)</span>
        </label>
        <p class="hint">
          Prüft Aufrufe unter Zeitfreigaben und mit Auto-Regel und schätzt neue oder geänderte Tools ein.
          Ausgeschaltet gelten Zeitfreigaben ohne Prüfung, Auto-Regeln fragen nach und Tools bekommen
          keine KI-Einschätzung.
        </p>
      </div>
    </section>
  {/if}

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
              <p class="hint unified-hint">
                Ein Konnektor für alle; Tool-Namen beginnen mit dem Kürzel (z. B. <code>{upstreams[0]!.slug}_…</code>).
                Mit der Claude-Anmeldung oder einem Token für alle Upstreams, nicht mit dem Token eines einzelnen Upstreams.
              </p>
              {#if unifiedShown}
                <div class="endpoint">
                <input
                  type="text"
                  readonly
                  value={unifiedEndpoint}
                  aria-label="MCP-Adresse für alle Upstreams"
                  onfocus={(e) => e.currentTarget.select()}
                />
                </div>
              {/if}
              <div class="item-actions">
                <button type="button" class="btn" aria-label="Adresse für alle Upstreams kopieren" onclick={copyUnified}>
                  {unifiedCopied ? 'Kopiert' : 'Adresse kopieren'}
                </button>
                <button type="button" class="btn" aria-label="Token für alle Upstreams erstellen" onclick={() => (tokenFor = 'all')}>
                  Token erstellen
                </button>
              </div>
            </li>
          </ul>
        {/if}
        <ul class="list" aria-label="Upstreams">
          {#each upstreams as u (u.id)}
            {@const fix = fixOf(u)}
            <li class="item upstream-row" data-slug={u.slug}>
              <div class="row">
                <!-- ADR-0033: switch off = paused (hidden from every client, never contacted). -->
                <Switch
                  checked={u.pausedAt === null}
                  label={`Aktiv: ${u.name}`}
                  disabled={pausingUpstreamId === u.id}
                  onchange={(on) => setUpstreamPaused(u, !on)}
                />
                <a class="row-link" href={`#/regeln/${u.id}`} aria-label={`${u.name} öffnen`}>
                  <span class="row-text">
                    <span class="row-head">
                      <span class="item-name" class:dim={u.pausedAt !== null}>{u.name}</span>
                      {#if u.pausedAt}
                        <span class="chip paused" data-testid="upstream-paused">pausiert</span>
                      {:else if unreachable(u)}
                        <span class="badge status-unreachable">Nicht erreichbar</span>
                      {:else if u.status !== 'CONNECTED'}
                        <span class="badge status-{u.status.toLowerCase()}">{STATUS_LABEL[u.status]}</span>
                      {/if}
                    </span>
                    <span class="row-sub">{u.slug}{u.allowInternal ? ' · intern' : ''}</span>
                  </span>
                  <span class="chev" aria-hidden="true">›</span>
                </a>
              </div>
              {#if fix === 'recheck'}
                <button type="button" class="btn primary wide fix" disabled={rechecking !== null} onclick={() => recheck(u)}>
                  {rechecking === u.id ? 'Prüfe…' : 'Erneut prüfen'}
                </button>
              {:else if fix === 'connect'}
                <button type="button" class="btn primary wide fix" disabled={connectingId !== null} onclick={() => connect(u)}>
                  {connectingId === u.id ? 'Verbinde…' : u.status === 'NOT_CONNECTED' ? 'Verbinden' : 'Neu verbinden'}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="hint endpoint-note">
          Schalter aus = pausiert: kein Client sieht den Upstream. Tippen öffnet Adresse, Token, Bearbeiten und die Regeln.
        </p>
      {/if}
      <button type="button" class="btn primary wide add-upstream" onclick={() => (sheet = 'new')}>
        Upstream hinzufügen
      </button>
      {#if !mcpConfigured}
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
            <li class="item client-row" data-client={c.id}>
              <div class="row">
                <!-- ADR-0024: switch off = paused (requests refused). -->
                <Switch
                  checked={c.pausedAt === null}
                  label={`Aktiv: ${c.name}`}
                  disabled={pausingId === c.id}
                  onchange={(on) => setPaused(c, !on)}
                />
                <a class="row-link" href={`#/client/${c.id}`} aria-label={`${c.name} öffnen`}>
                  <span class="row-text">
                    <span class="row-head">
                      <span class="item-name" class:dim={c.pausedAt !== null}>{c.name}</span>
                      {#if c.pausedAt}<span class="chip paused" data-testid="client-paused">pausiert</span>{/if}
                    </span>
                    <span class="row-sub">
                      {clientKind(c)} · {c.lastUsedAt ? `zuletzt ${dateTime.format(new Date(c.lastUsedAt))}` : 'noch nie benutzt'}
                    </span>
                  </span>
                  <span class="chev" aria-hidden="true">›</span>
                </a>
              </div>
            </li>
          {/each}
        </ul>
        <p class="hint endpoint-note">Schalter aus = pausiert: Anfragen werden abgewiesen. Tippen öffnet Umbenennen, Web-Adressen und Trennen.</p>
      {/if}
    </section>

    <section aria-labelledby="sessions-title">
      <h2 id="sessions-title">Sitzungen</h2>
      <a class="btn wide" href="#/sitzungen">Sitzungen ansehen</a>
      <p class="hint section-hint">Welcher Client wann eine Sitzung geöffnet hat und welche Aufrufe dazugehören.</p>
    </section>
  {/if}

  {#if version}
    <footer class="app-version" data-testid="app-version">xitl {versionLabel}</footer>
  {/if}
</div>

<style>
  .chip.paused {
    color: var(--warn);
    border-color: var(--warn);
    background: var(--warn-soft);
    font-weight: 600;
  }
  .unified-hint {
    margin: 0.25rem 0 0;
  }
  .upstream-row .row,
  .client-row .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .row-link {
    flex: 1;
    min-width: 0;
    min-height: var(--tap);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: inherit;
    text-decoration: none;
  }
  .row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
  }
  .row-sub {
    font-size: 0.8125rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .dim {
    color: var(--muted);
  }
  .chev {
    flex: none;
    color: var(--muted);
    font-size: 1.5rem;
    line-height: 1;
  }
  .fix {
    margin-top: 0.5rem;
  }
  .app-version {
    margin: 1.5rem 0 0.5rem;
    text-align: center;
    color: var(--muted);
    font-size: 0.8125rem;
  }
</style>

{#if sheet}
  <UpstreamSheet onclose={() => (sheet = null)} onsave={save} />
{/if}

{#if tokenFor}
  <TokenSheet upstream={null} onclose={() => (tokenFor = null)} oncreated={load} />
{/if}


