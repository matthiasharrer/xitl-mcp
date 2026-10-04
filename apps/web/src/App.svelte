<script lang="ts">
  import { api, type Me } from './lib/api';
  import Icon from './lib/Icon.svelte';
  import Toast from './lib/Toast.svelte';
  import Settings from './routes/Settings.svelte';

  let me = $state<Me | null>(null);
  let error = $state<string | null>(null);

  api.me().then((m) => (me = m), (e) => (error = String(e)));

  // Two views, in the URL hash so reload and browser-back keep working
  // (pattern from haushalts-todos).
  type View = 'home' | 'settings';
  const viewOf = (hash: string): View => (hash === '#/einstellungen' ? 'settings' : 'home');
  let view = $state<View>(viewOf(location.hash));
</script>

<svelte:window onhashchange={() => (view = viewOf(location.hash))} />

<div class="app">
  <header class="app-bar"><h1>xitl</h1></header>

  <main class="page">
    {#if view === 'settings'}
      <Settings />
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
    <a href="#/" aria-current={view === 'home' ? 'page' : undefined}>
      <Icon name="home" /><span>Start</span>
    </a>
    <a href="#/einstellungen" aria-current={view === 'settings' ? 'page' : undefined}>
      <Icon name="settings" /><span>Einstellungen</span>
    </a>
  </nav>
</div>
