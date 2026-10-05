<script lang="ts">
  // Bottom-sheet dialog to edit an access token's browser origins (ADR-0023):
  // one per line, saved with PATCH /api/mcp/clients/:id (an empty field
  // removes them all). TOKEN clients only. Same shell as TokenSheet.
  import { onMount } from 'svelte';
  import { api, messageOf, originLines, type McpClient } from './api';
  import Icon from './Icon.svelte';

  interface Props {
    client: McpClient;
    onclose: () => void;
    /** Called after saving (the parent reloads its client list). */
    onsaved: () => void;
  }
  let { client, onclose, onsaved }: Props = $props();

  // svelte-ignore state_referenced_locally
  let origins = $state(client.allowedOrigins.join('\n'));
  let busy = $state(false);
  let error = $state<string | null>(null);
  let dialog: HTMLDialogElement;

  onMount(() => dialog.showModal());

  async function save(e: Event) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    try {
      await api.setClientOrigins(client.id, originLines(origins));
      onsaved();
    } catch (err) {
      error = messageOf(err);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="origins-sheet-title"
  oncancel={(e) => {
    e.preventDefault();
    onclose();
  }}
  onclick={(e) => {
    if (e.target === dialog) onclose();
  }}
>
  <form class="sheet-inner" onsubmit={save}>
    <header class="sheet-head">
      <h2 id="origins-sheet-title">Web-Adressen</h2>
      <button type="button" class="icon-btn" aria-label="Schließen" onclick={onclose}>
        <Icon name="x" />
      </button>
    </header>

    <div class="sheet-body">
      <p class="hint">Welche Web-Seiten das Token „{client.name}“ im Browser benutzen dürfen.</p>
      <label class="field">
        <span class="label">Erlaubte Web-Adressen (Browser-Clients)</span>
        <textarea
          bind:value={origins}
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="http://localhost:8080"
          aria-invalid={error ? 'true' : undefined}
        ></textarea>
        {#if error}
          <span class="field-error" role="alert">{error}</span>
        {/if}
        <span class="hint">
          Eine Adresse pro Zeile, wie <code>http://localhost:8080</code> (z. B. die Web-Oberfläche von llama.cpp). Leer:
          kein Browser darf es benutzen.
        </span>
      </label>
    </div>

    <footer class="sheet-foot">
      <button type="submit" class="btn primary wide" disabled={busy}>{busy ? 'Speichere…' : 'Speichern'}</button>
    </footer>
  </form>
</dialog>
