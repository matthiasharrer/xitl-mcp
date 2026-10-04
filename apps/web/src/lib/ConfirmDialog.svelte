<script lang="ts">
  // Confirmation dialog for destructive actions (copied from haushalts-todos,
  // which adapted it from rezepte). Mounted with {#if}; presence in the DOM is
  // the open state. Cancel is the safe default: nothing is autofocused.
  import { onMount } from 'svelte';

  interface Props {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    onconfirm: () => void;
    oncancel: () => void;
  }
  let { title, message, confirmLabel, cancelLabel = 'Abbrechen', onconfirm, oncancel }: Props = $props();

  let dialog: HTMLDialogElement;
  onMount(() => dialog.showModal());
</script>

<dialog
  bind:this={dialog}
  class="confirm"
  aria-labelledby="confirm-title"
  oncancel={(e) => {
    e.preventDefault();
    oncancel();
  }}
  onclick={(e) => {
    if (e.target === dialog) oncancel();
  }}
>
  <h2 id="confirm-title">{title}</h2>
  <p>{message}</p>
  <div class="confirm-actions">
    <button type="button" class="btn" onclick={oncancel}>{cancelLabel}</button>
    <button type="button" class="btn danger" onclick={onconfirm}>{confirmLabel}</button>
  </div>
</dialog>
