<script lang="ts">
  import { shared } from './store.svelte';
</script>

{#if shared.toast}
  {#key shared.toast.id}
    <div class="toast" class:toast-error={shared.toast.error} role={shared.toast.error ? 'alert' : 'status'}>
      <span class="toast-text">{shared.toast.text}</span>
    </div>
  {/key}
{/if}
