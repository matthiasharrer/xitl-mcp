<script lang="ts">
  // Bottom-sheet dialog to create an access token for one upstream (ADR-0015).
  // Step 1 asks for a name; step 2 shows the token ONCE with a copy button and
  // a ready-made client config. Same shell as UpstreamSheet.
  import { onMount } from 'svelte';
  import { api, messageOf, type Upstream } from './api';
  import Icon from './Icon.svelte';

  interface Props {
    upstream: Upstream;
    onclose: () => void;
    /** Called once the token exists (the parent reloads its client list). */
    oncreated: () => void;
  }
  let { upstream, onclose, oncreated }: Props = $props();

  let name = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let token = $state<string | null>(null);
  let copied = $state<string | null>(null);
  let dialog: HTMLDialogElement;

  onMount(() => dialog.showModal());

  // svelte-ignore state_referenced_locally
  const slug = upstream.slug;
  const endpoint = `${location.origin}/mcp/${slug}`;
  const cliName = slug;
  const command = $derived(
    `claude mcp add --transport http ${cliName} ${endpoint} --header "Authorization: Bearer ${token ?? ''}"`,
  );
  const headerLine = $derived(`Authorization: Bearer ${token ?? ''}`);

  async function create(e: Event) {
    e.preventDefault();
    if (name.trim() === '' || busy) return;
    busy = true;
    error = null;
    try {
      const res = await api.createUpstreamToken(upstream.id, name.trim());
      token = res.token;
      oncreated();
    } catch (err) {
      error = messageOf(err);
    } finally {
      busy = false;
    }
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard unavailable: the text is selectable (tap selects all)
    }
    copied = key;
    setTimeout(() => copied === key && (copied = null), 2000);
  }
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="token-sheet-title"
  oncancel={(e) => {
    e.preventDefault();
    onclose();
  }}
  onclick={(e) => {
    if (e.target === dialog) onclose();
  }}
>
  <form class="sheet-inner" onsubmit={create}>
    <header class="sheet-head">
      <h2 id="token-sheet-title">{token === null ? 'Token erstellen' : 'Token erstellt'}</h2>
      <button type="button" class="icon-btn" aria-label="Schließen" onclick={onclose}>
        <Icon name="x" />
      </button>
    </header>

    <div class="sheet-body">
      {#if token === null}
        <p class="hint">
          Ein Token gilt nur für „{upstream.name}“ ({endpoint}) und lässt sich jederzeit widerrufen.
        </p>
        <label class="field">
          <span class="label">Name des Clients</span>
          <input
            type="text"
            bind:value={name}
            maxlength="100"
            required
            autocomplete="off"
            placeholder="z. B. Claude Code Laptop"
          />
        </label>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      {:else}
        <p class="token-note">Wird nur jetzt angezeigt.</p>
        <pre class="token-box" data-testid="token-value">{token}</pre>
        <button type="button" class="btn primary wide" onclick={() => copy('token', token!)}>
          {copied === 'token' ? 'Kopiert' : 'Token kopieren'}
        </button>

        <div class="field">
          <span class="label">Claude Code</span>
          <pre class="token-box" data-testid="token-command">{command}</pre>
          <button type="button" class="btn wide" onclick={() => copy('command', command)}>
            {copied === 'command' ? 'Kopiert' : 'Befehl kopieren'}
          </button>
        </div>

        <div class="field">
          <span class="label">Andere Clients</span>
          <pre class="token-box">Header: {headerLine}</pre>
        </div>
        <p class="hint">
          Das Token landet in der Konfigurationsdatei des Clients. Wer es hat, erreicht „{upstream.name}“ unter deinen
          Regeln. Unter „MCP-Clients“ kannst du es trennen.
        </p>
      {/if}
    </div>

    <footer class="sheet-foot">
      {#if token === null}
        <button type="submit" class="btn primary wide" disabled={name.trim() === '' || busy}>
          {busy ? 'Erstelle…' : 'Erstellen'}
        </button>
      {:else}
        <button type="button" class="btn primary wide" onclick={onclose}>Fertig</button>
      {/if}
    </footer>
  </form>
</dialog>
