<script lang="ts">
  import { api, type Me } from './lib/api';
  import Icon from './lib/Icon.svelte';
  import Toast from './lib/Toast.svelte';
  import Settings from './routes/Settings.svelte';
  import Rules from './routes/Rules.svelte';
  import Approvals from './routes/Approvals.svelte';
  import Approval from './routes/Approval.svelte';
  import History from './routes/History.svelte';
  import HistoryDetail from './routes/HistoryDetail.svelte';
  import Sessions from './routes/Sessions.svelte';
  import SessionDetail from './routes/SessionDetail.svelte';

  let me = $state<Me | null>(null);
  let error = $state<string | null>(null);

  api.me().then((m) => (me = m), (e) => (error = String(e)));

  // Views in the URL hash so reload and browser-back keep working (pattern
  // from haushalts-todos). A "?…" after the path carries one-shot messages
  // (e.g. the upstream OAuth callback's result); Settings reads and drops it.
  // #/freigabe/<id> is the push notification's deep link (ADR-0009).
  type View =
    | { name: 'home' }
    | { name: 'approval'; id: string }
    | { name: 'history' }
    | { name: 'audit'; id: number }
    | { name: 'settings' }
    | { name: 'sessions' }
    | { name: 'session'; id: string }
    | { name: 'rules'; upstreamId: number };
  function viewOf(hash: string): View {
    const path = hash.split('?')[0];
    if (path === '#/einstellungen') return { name: 'settings' };
    if (path === '#/verlauf') return { name: 'history' };
    if (path === '#/sitzungen') return { name: 'sessions' };
    let m = /^#\/regeln\/(\d{1,9})$/.exec(path);
    if (m) return { name: 'rules', upstreamId: Number(m[1]) };
    m = /^#\/verlauf\/(\d{1,9})$/.exec(path);
    if (m) return { name: 'audit', id: Number(m[1]) };
    m = /^#\/sitzungen\/([A-Za-z0-9_-]{43})$/.exec(path);
    if (m) return { name: 'session', id: m[1] };
    m = /^#\/freigabe\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m) return { name: 'approval', id: m[1] };
    return { name: 'home' };
  }
  let view = $state<View>(viewOf(location.hash));
  const tab = $derived(
    view.name === 'home' || view.name === 'approval' ? 'approvals' : view.name === 'history' || view.name === 'audit' ? 'history' : 'settings',
  );
</script>

<svelte:window onhashchange={() => (view = viewOf(location.hash))} />

<div class="app">
  <header class="app-bar">
    <h1>xitl</h1>
  </header>

  <main class="page">
    {#if error}
      <p class="error">Fehler: {error}</p>
    {:else if view.name === 'settings'}
      <Settings />
    {:else if view.name === 'rules'}
      {#key view.upstreamId}<Rules upstreamId={view.upstreamId} />{/key}
    {:else if view.name === 'sessions'}
      <Sessions />
    {:else if view.name === 'session'}
      {#key view.id}<SessionDetail id={view.id} />{/key}
    {:else if view.name === 'history'}
      <History />
    {:else if view.name === 'audit'}
      {#key view.id}<HistoryDetail id={view.id} />{/key}
    {:else if view.name === 'approval'}
      {#key view.id}<Approval id={view.id} />{/key}
    {:else}
      <Approvals {me} />
    {/if}
  </main>

  <Toast />
  <nav class="tab-bar" aria-label="Ansicht">
    <a href="#/" aria-current={tab === 'approvals' ? 'page' : undefined}>
      <Icon name="inbox" /><span>Freigaben</span>
    </a>
    <a href="#/verlauf" aria-current={tab === 'history' ? 'page' : undefined}>
      <Icon name="history" /><span>Verlauf</span>
    </a>
    <a href="#/einstellungen" aria-current={tab === 'settings' ? 'page' : undefined}>
      <Icon name="settings" /><span>Einstellungen</span>
    </a>
  </nav>
</div>
