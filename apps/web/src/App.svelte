<script lang="ts">
  import { api, type Me } from './lib/api';

  let me = $state<Me | null>(null);
  let error = $state<string | null>(null);

  api.me().then((m) => (me = m), (e) => (error = String(e)));
</script>

<header class="app-bar"><h1>xitl</h1></header>

<main class="page">
  {#if error}
    <p class="error">Fehler: {error}</p>
  {:else if me}
    <p>Hallo, {me.displayName}</p>
    <p class="muted">Keine offenen Freigaben.</p>
  {:else}
    <p class="muted">Lädt…</p>
  {/if}
</main>
