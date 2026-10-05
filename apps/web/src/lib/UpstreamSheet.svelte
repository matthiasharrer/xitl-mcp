<script lang="ts">
  // Bottom-sheet dialog to add or edit one upstream (pattern from haushalts-todos'
  // TaskSheet). Native <dialog>: Escape and the backdrop tap close it. The save
  // action is an async callback owned by the parent; a rejection shows inline.
  import { onMount } from 'svelte';
  import { ApiError, type Policy, type Upstream, type UpstreamAuth, type UpstreamInput } from './api';
  import Icon from './Icon.svelte';

  interface Props {
    /** Omit to add a new upstream. */
    upstream?: Upstream;
    onclose: () => void;
    onsave: (input: UpstreamInput) => Promise<void>;
  }
  let { upstream, onclose, onsave }: Props = $props();

  // The sheet edits a snapshot: a background refetch must not clobber typing.
  // svelte-ignore state_referenced_locally
  const u = upstream;
  const creating = u === undefined;
  let name = $state(u?.name ?? '');
  let slug = $state(u?.slug ?? '');
  // While adding, the slug follows the name until the user edits it themselves.
  let slugTouched = $state(!creating);
  let url = $state(u?.url ?? '');
  let description = $state(u?.description ?? '');
  let defaultPolicy = $state<Policy>(u?.defaultPolicy ?? 'ASK');
  let auth = $state<UpstreamAuth>(u?.auth ?? 'OAUTH');
  let headerName = $state(u?.headerName ?? '');
  let headerValue = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  // The API refused the URL as internal (ADR-0020): explain, offer "Trotzdem
  // erlauben". Cleared as soon as the URL changes.
  let internalHint = $state<string | null>(null);
  let dialog: HTMLDialogElement;

  onMount(() => dialog.showModal());

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '');
  }

  function onName() {
    if (!slugTouched) slug = slugify(name);
  }

  // ADR-0021: a stored header value was given for the old address. Pointing a
  // HEADER upstream elsewhere needs the value again (the API refuses
  // otherwise with code 'header_value_required').
  const needsNewHeaderValue = $derived(!creating && auth === 'HEADER' && url.trim() !== u?.url);
  const keepsStoredHeaderValue = $derived((u?.hasHeaderValue ?? false) && !needsNewHeaderValue);
  // The API's refusal of the header value, shown at that field.
  let headerValueError = $state<string | null>(null);

  const canSave = $derived(
    name.trim() !== '' &&
      slug !== '' &&
      url.trim() !== '' &&
      !busy &&
      (auth !== 'HEADER' || (headerName.trim() !== '' && (headerValue !== '' || keepsStoredHeaderValue))),
  );

  async function save(e: Event, allowInternal = false) {
    e.preventDefault();
    if (!canSave) return;
    busy = true;
    error = null;
    internalHint = null;
    headerValueError = null;
    const input: UpstreamInput = {
      name: name.trim(),
      slug,
      url: url.trim(),
      description: description.trim() === '' ? null : description.trim(),
      defaultPolicy,
      auth,
    };
    if (allowInternal) input.allowInternal = true;
    if (auth === 'HEADER') {
      input.headerName = headerName.trim();
      // Empty on edit = keep the stored value (it is write-only).
      if (headerValue !== '') input.headerValue = headerValue;
    }
    try {
      await onsave(input);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'internal_address' && !allowInternal) internalHint = err.message;
      else if (err instanceof ApiError && err.code === 'header_value_required') headerValueError = err.message;
      else error = err instanceof Error ? err.message : 'Das hat nicht geklappt.';
      busy = false;
    }
  }

  const policies: { value: Policy; label: string }[] = [
    { value: 'ALLOW', label: 'Erlauben' },
    { value: 'ASK', label: 'Fragen' },
    { value: 'DENY', label: 'Verbieten' },
  ];
  const auths: { value: UpstreamAuth; label: string }[] = [
    { value: 'OAUTH', label: 'OAuth' },
    { value: 'HEADER', label: 'Header' },
    { value: 'NONE', label: 'Keine' },
  ];
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="sheet-title"
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
      <h2 id="sheet-title">{creating ? 'Upstream hinzufügen' : 'Upstream bearbeiten'}</h2>
      <button type="button" class="icon-btn" aria-label="Schließen" onclick={onclose}>
        <Icon name="x" />
      </button>
    </header>

    <div class="sheet-body">
      <label class="field">
        <span class="label">Name</span>
        <input type="text" bind:value={name} oninput={onName} maxlength="100" required autocomplete="off" />
      </label>

      <label class="field">
        <span class="label">Slug</span>
        <input
          type="text"
          bind:value={slug}
          oninput={() => (slugTouched = true)}
          maxlength="32"
          required
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="hint">Kommt in die Adresse: /mcp/{slug || '…'}</span>
      </label>

      <label class="field">
        <span class="label">URL</span>
        <input
          type="url"
          bind:value={url}
          oninput={() => (internalHint = null)}
          placeholder="https://…/mcp"
          required
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      <label class="field">
        <span class="label">Beschreibung</span>
        <textarea bind:value={description} rows="3" maxlength="1000"></textarea>
        <span class="hint">Sagt dem Agenten, wofür dieser Upstream da ist.</span>
      </label>

      <fieldset class="field">
        <legend class="label">Standard-Regel für Tools</legend>
        <div class="segmented">
          {#each policies as p}
            <label class:selected={defaultPolicy === p.value}>
              <input type="radio" name="policy" value={p.value} bind:group={defaultPolicy} />
              {p.label}
            </label>
          {/each}
        </div>
      </fieldset>

      <fieldset class="field">
        <legend class="label">Anmeldung beim Upstream</legend>
        <div class="segmented">
          {#each auths as a}
            <label class:selected={auth === a.value}>
              <input type="radio" name="auth" value={a.value} bind:group={auth} />
              {a.label}
            </label>
          {/each}
        </div>
      </fieldset>

      {#if auth === 'HEADER'}
        <label class="field">
          <span class="label">Header-Name</span>
          <input
            type="text"
            bind:value={headerName}
            placeholder="Authorization"
            autocapitalize="none"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <label class="field">
          <span class="label">Header-Wert</span>
          <input
            type="password"
            bind:value={headerValue}
            oninput={() => (headerValueError = null)}
            autocomplete="off"
            required={!keepsStoredHeaderValue}
            aria-invalid={headerValueError !== null}
            aria-describedby={needsNewHeaderValue && u?.hasHeaderValue ? 'header-value-new-url' : undefined}
            placeholder={keepsStoredHeaderValue ? 'gespeichert, leer lassen zum Behalten' : ''}
          />
          {#if headerValueError}
            <span class="field-error" role="alert">{headerValueError}</span>
          {:else if needsNewHeaderValue && u?.hasHeaderValue}
            <span class="hint new-url" id="header-value-new-url">Neue Adresse: Header-Wert bitte neu eingeben.</span>
          {:else}
            <span class="hint">Wird nie wieder angezeigt.</span>
          {/if}
        </label>
      {/if}

      <!-- The message sits at the end of a scrolling sheet, under the sticky
           button on a phone: bring it into view whenever it changes. -->
      {#if error}<p
          class="error"
          role="alert"
          {@attach (el) => {
            void error;
            el.scrollIntoView({ block: 'nearest' });
          }}
        >
          {error}
        </p>{/if}

      {#if internalHint}
        <div
          class="internal-hint"
          role="alert"
          {@attach (el) => {
            el.scrollIntoView({ block: 'nearest' });
          }}
        >
          <p>{internalHint}</p>
          <p>
            Solche Adressen (z. B. localhost, 192.168.…, Cluster-Dienste) sind sonst gesperrt, damit ein fremder
            Dienst xitl nicht in dein Heimnetz schicken kann. Erlaubt wird dann nur genau diese Adresse.
            <strong>Erlaube es nur, wenn du dem Dienst vertraust.</strong>
          </p>
          <button type="button" class="btn wide" disabled={busy} onclick={(e) => save(e, true)}>Trotzdem erlauben</button>
        </div>
      {/if}
    </div>

    <footer class="sheet-foot">
      <button type="submit" class="btn primary wide" disabled={!canSave}>
        {creating ? 'Hinzufügen' : 'Speichern'}
      </button>
    </footer>
  </form>
</dialog>
