<script lang="ts">
  // Bottom-sheet dialog to create an access token (ADR-0015, ADR-0018) for one
  // upstream, or for all upstreams (`upstream` null: endpoint /mcp).
  // Step 1 asks for a name and, optionally, the web pages that may use the
  // token from a browser (ADR-0023); step 2 shows the token ONCE with a copy
  // button and a ready-made client config. Same shell as UpstreamSheet.
  import { onMount } from 'svelte';
  import { api, ApiError, messageOf, originLines, type Upstream } from './api';
  import Icon from './Icon.svelte';

  interface Props {
    /** null: a token for all upstreams. */
    upstream: Upstream | null;
    onclose: () => void;
    /** Called once the token exists (the parent reloads its client list). */
    oncreated: () => void;
  }
  let { upstream, onclose, oncreated }: Props = $props();

  let name = $state('');
  let origins = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** A 400 about the origins, shown at their field. */
  let originsError = $state<string | null>(null);
  let token = $state<string | null>(null);
  let copied = $state<string | null>(null);
  let dialog: HTMLDialogElement;

  onMount(() => dialog.showModal());

  // svelte-ignore state_referenced_locally
  const endpoint = upstream ? `${location.origin}/mcp/${upstream.slug}` : `${location.origin}/mcp`;
  // svelte-ignore state_referenced_locally
  const cliName = upstream ? upstream.slug : 'xitl';
  // svelte-ignore state_referenced_locally
  const reach = upstream ? `„${upstream.name}“` : 'alle deine Upstreams (auch später hinzugefügte)';
  const command = $derived(
    `claude mcp add --transport http ${cliName} ${endpoint} --header "Authorization: Bearer ${token ?? ''}"`,
  );
  const headerLine = $derived(`Authorization: Bearer ${token ?? ''}`);

  async function create(e: Event) {
    e.preventDefault();
    if (name.trim() === '' || busy) return;
    busy = true;
    error = null;
    originsError = null;
    const allowed = originLines(origins);
    try {
      const res = upstream
        ? await api.createUpstreamToken(upstream.id, name.trim(), allowed)
        : await api.createAllUpstreamsToken(name.trim(), allowed);
      token = res.token;
      oncreated();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_origin') originsError = err.message;
      else error = messageOf(err);
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
          {#if upstream}
            Ein Token gilt nur für „{upstream.name}“ ({endpoint}) und lässt sich jederzeit widerrufen.
          {:else}
            Dieses Token gilt für alle deine Upstreams, auch später hinzugefügte ({endpoint} und jede
            Upstream-Adresse). Es lässt sich jederzeit widerrufen.
          {/if}
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
        <label class="field">
          <span class="label">Erlaubte Web-Adressen (Browser-Clients)</span>
          <textarea
            bind:value={origins}
            rows="2"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="http://localhost:8080"
            aria-invalid={originsError ? 'true' : undefined}
          ></textarea>
          {#if originsError}
            <span class="field-error" role="alert">{originsError}</span>
          {/if}
          <span class="hint">
            Optional. Nur für Clients, die im Browser laufen (z. B. die Web-Oberfläche von llama.cpp): eine Adresse pro
            Zeile, wie <code>http://localhost:8080</code>. Leer lassen für Claude Code und andere Programme.
          </span>
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
          Das Token landet in der Konfigurationsdatei des Clients. Wer es hat, erreicht {reach} unter deinen
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
