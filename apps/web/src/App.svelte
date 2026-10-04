<script lang="ts">
  import { api, type Me } from './lib/api';
  import Icon from './lib/Icon.svelte';
  import Toast from './lib/Toast.svelte';
  import Settings from './routes/Settings.svelte';
  import Rules from './routes/Rules.svelte';

  let me = $state<Me | null>(null);
  let error = $state<string | null>(null);

  api.me().then((m) => (me = m), (e) => (error = String(e)));

  // Views in the URL hash so reload and browser-back keep working (pattern
  // from haushalts-todos). A "?…" after the path carries one-shot messages
  // (e.g. the upstream OAuth callback's result); Settings reads and drops it.
  type View = { name: 'home' } | { name: 'settings' } | { name: 'rules'; upstreamId: number };
  function viewOf(hash: string): View {
    const path = hash.split('?')[0];
    if (path === '#/einstellungen') return { name: 'settings' };
    const m = /^#\/regeln\/(\d{1,9})$/.exec(path);
    if (m) return { name: 'rules', upstreamId: Number(m[1]) };
    return { name: 'home' };
  }
  let view = $state<View>(viewOf(location.hash));
</script>

<svelte:window onhashchange={() => (view = viewOf(location.hash))} />

<div class="app">
  <header class="app-bar"><h1>xitl</h1></header>

  <main class="page">
    {#if view.name === 'settings'}
      <Settings />
    {:else if view.name === 'rules'}
      {#key view.upstreamId}<Rules upstreamId={view.upstreamId} />{/key}
    {:else if error}
      <p class="error">Fehler: {error}</p>
    {:else if me}
      <p>Hallo, {me.displayName}</p>
      <p class="muted">Keine offenen Freigaben.</p>
    {:else}
      <p class="muted">Lädt…</p>
    {/if}
  </main>

  <Toast />
  <nav class="tab-bar" aria-label="Ansicht">
    <a href="#/" aria-current={view.name === 'home' ? 'page' : undefined}>
      <Icon name="home" /><span>Start</span>
    </a>
    <a href="#/einstellungen" aria-current={view.name !== 'home' ? 'page' : undefined}>
      <Icon name="settings" /><span>Einstellungen</span>
    </a>
  </nav>
</div>
