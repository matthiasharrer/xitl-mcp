<script lang="ts">
  import { appUpdate, reloadApp } from './appUpdate.svelte';
</script>

{#if appUpdate.available}
  <div class="update-banner" role="status">
    <span class="update-text">Neue Version verfügbar</span>
    <button type="button" class="update-action" onclick={() => void reloadApp()}>Neu laden</button>
  </div>
{/if}

<style>
  .update-banner {
    position: fixed;
    z-index: 50;
    top: calc(env(safe-area-inset-top) + 8px);
    left: var(--gutter);
    right: var(--gutter);
    max-width: calc(40rem - 2 * var(--gutter));
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.25rem 0.5rem 0.25rem 1rem;
    min-height: var(--tap);
    border-radius: var(--radius);
    background: var(--toast-bg);
    color: var(--toast-fg);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
  }
  .update-text {
    overflow-wrap: anywhere;
  }
  .update-action {
    flex: none;
    min-height: var(--tap);
    padding: 0 0.75rem;
    border: 0;
    background: none;
    font: inherit;
    font-weight: 700;
    color: light-dark(#aab6f0, #3b4a8c); /* --accent-text, inverted like the pill */
    cursor: pointer;
  }
</style>
