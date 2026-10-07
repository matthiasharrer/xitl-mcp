<script lang="ts">
  // One held call (ADR-0004): who asks, what, with which arguments, how long
  // it still waits; Ablehnen / Erlauben, the allow-pause choices (TC-27…30)
  // and the deny pause "Ablehnen und nicht mehr fragen" (ADR-0026, TC-125).
  // Arguments come from the (untrusted) agent: shown as text, never as HTML.
  import { onDestroy, untrack } from 'svelte';
  import { api, ApiError, autoCheckNote, messageOf, pauseCheckNote, sperreCheckNote, type ApprovalDecision, type PendingApproval, type SnoozeScope } from './api';
  import { showToast } from './store.svelte';
  import SessionLine from './SessionLine.svelte';
  import IntentSummary from './IntentSummary.svelte';
  import CallWhat from './CallWhat.svelte';
  import { purposeChips, purposeFields } from './purpose';

  let {
    approval,
    ondone,
  }: {
    approval: PendingApproval;
    /** Called once the call left the "open" state from this card. */
    ondone?: (id: string, result: 'approved' | 'denied' | 'gone') => void;
  } = $props();

  // Countdown from the server's remainingMs (no trust in clock agreement).
  // (The card is keyed by call id, so the first value is the one that counts.)
  const deadline = Date.now() + untrack(() => approval.remainingMs);
  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));
  const left = $derived(Math.max(0, deadline - now));
  const expired = $derived(left <= 0);
  const leftText = $derived(`${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`);

  let busy = $state(false);
  /** What "nicht mehr fragen" covers; "nur dieses Tool" unless chosen. */
  let scope = $state<SnoozeScope>('tool');
  const scopeText = $derived(
    scope === 'upstream'
      ? `alle Tools von ${approval.upstream.name}`
      : scope === 'readonly'
        ? `alle Lesetools von ${approval.upstream.name}`
        : approval.tool,
  );
  /** ADR-0029/0026 amendment: optional "Wofür?" of the Zeitfreigabe or
   * Sperre (≤ 200). With a Sperre, Clef may ask (never allow) calls clearly
   * outside it. */
  let purpose = $state('');
  /** TC-172…174: the AI suggestion chip last tapped (null: none). The field
   * counts as suggested only while it holds exactly that text. Chips only
   * where a Zeitfreigabe is possible, and only once the summary is there. */
  let suggested = $state<string | null>(null);
  const chips = $derived(
    approval.snoozable && approval.intentStatus === 'DONE' ? purposeChips(approval.intentPurposeNarrow, approval.intentPurposeKind) : [],
  );
  const fromChip = $derived(suggested !== null && purpose.trim() !== '' && purpose.trim() === suggested.trim());
  const pick = (text: string) => {
    purpose = text;
    suggested = text;
  };
  const snooze = (d: { snoozeMinutes?: number; snoozeUntilMidnight?: boolean }, label: string) =>
    decide(
      { decision: 'approve', ...d, snoozeScope: scope, ...purposeFields('allow', purpose, suggested) },
      `Erlaubt, ${label} ohne Nachfrage: ${scopeText}`,
    );

  /** ADR-0026: what "Ablehnen und nicht mehr fragen" blocks. */
  let denyScope = $state<'tool' | 'upstream'>('tool');
  const denyScopeText = $derived(denyScope === 'upstream' ? `alle Tools von ${approval.upstream.name}` : approval.tool);
  const denyPause = (d: { snoozeMinutes?: number; snoozeUntilMidnight?: boolean }, label: string) =>
    decide(
      // S3: an untouched suggestion is never a Sperre's purpose.
      { decision: 'deny', ...d, snoozeScope: denyScope, ...purposeFields('deny', purpose, suggested) },
      `Abgelehnt, ${label} gesperrt: ${denyScopeText}${fromChip ? ' (ohne KI-Vorschlag als Zweck)' : ''}`,
    );

  const argsText = $derived.by(() => {
    try {
      return JSON.stringify(approval.arguments, null, 2) ?? '';
    } catch {
      return String(approval.arguments);
    }
  });
  // ADR-0025: with a summary, the raw arguments sit behind "Rohdaten"; open
  // unless the summary was already there when the card appeared (never
  // collapsed under the reader's finger when it arrives later).
  const withIntent = $derived(approval.intentStatus !== undefined && approval.intentStatus !== 'OFF');
  const rawOpen = untrack(() => approval.intentStatus !== 'DONE');
  const noArgs = $derived(
    approval.arguments === null ||
      (typeof approval.arguments === 'object' && Object.keys(approval.arguments as object).length === 0),
  );

  async function decide(d: ApprovalDecision, done: string) {
    busy = true;
    try {
      const res = await api.decideApproval(approval.id, d);
      const more = res.alsoDecided ?? 0;
      showToast(more > 0 ? `${done} – dazu ${more} wartende ${more === 1 ? 'Freigabe' : 'Freigaben'} ${res.state === 'approved' ? 'erlaubt' : 'gesperrt'}` : done);
      ondone?.(approval.id, res.state);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        showToast('Diese Freigabe ist nicht mehr offen.', { error: true });
        ondone?.(approval.id, 'gone');
      } else {
        showToast(messageOf(e), { error: true });
      }
    } finally {
      busy = false;
    }
  }
</script>

<article class="approval card" data-approval={approval.id} aria-label={`Freigabe: ${approval.tool}`}>
  <div class="approval-head">
    <span class="approval-client">{approval.clientName}</span>
    <span class="countdown" class:urgent={left < 60_000} role="timer" aria-label="Zeit übrig">
      {expired ? 'abgelaufen' : `noch ${leftText}`}
    </span>
  </div>
  <CallWhat
    tool={approval.tool}
    upstream={approval.upstream.name}
    title={approval.intentStatus === 'DONE' ? approval.intentTitle : null}
    pending={approval.intentStatus === 'PENDING'}
  />
  <SessionLine session={approval.session} />
  {#if approval.pauseCheck}
    <!-- ADR-0029: why a call under a Zeitfreigabe is asked after all. -->
    <p class="pause-check-note" class:mismatch={approval.pauseCheck.result === 'mismatch'} data-pause-check={approval.pauseCheck.result}>
      {pauseCheckNote(approval.pauseCheck)}
    </p>
  {/if}
  {#if approval.sperreCheck}
    <!-- ADR-0026 amendment: outside the Sperre's purpose, so asked. -->
    <p class="pause-check-note" data-sperre-check>{sperreCheckNote(approval.sperreCheck.purpose)}</p>
  {/if}
  {#if approval.autoCheck}
    <!-- ADR-0030: why an AUTO call is asked. -->
    <p class="pause-check-note" data-auto-check={approval.autoCheck.result}>{autoCheckNote(approval.autoCheck)}</p>
  {/if}
  {#if !approval.snoozable}
    <p class="hint approval-new">
      Neues oder geändertes Tool. Prüfe es in den <a href={`#/regeln/${approval.upstream.id}`}>Regeln</a>.
    </p>
    {#if approval.toolReview}
      <!-- ADR-0031: advisory review hint (as when the call was held). -->
      <div class="tool-review" class:attention={approval.toolReview.attention} data-tool-review={approval.toolReview.attention ? 'attention' : 'ok'}>
        {#if approval.toolReview.attention}
          <p class="tool-review-head">Genauer ansehen</p>
          <ul>
            {#each approval.toolReview.reasons as reason}<li>{reason}</li>{/each}
          </ul>
        {:else}
          <p class="tool-review-head ok">Unauffällig</p>
        {/if}
        {#if approval.toolReview.label}<p class="tool-review-label">{approval.toolReview.label}</p>{/if}
      </div>
    {/if}
  {/if}

  <IntentSummary intent={approval} />

  {#if noArgs}
    <p class="hint">Ohne Argumente.</p>
  {:else if withIntent}
    <details class="raw" open={rawOpen}>
      <summary>Rohdaten</summary>
      <pre class="args" aria-label="Argumente">{argsText}</pre>
    </details>
  {:else}
    <pre class="args" aria-label="Argumente">{argsText}</pre>
  {/if}

  <div class="decide-row">
    <button type="button" class="btn danger-outline" disabled={busy || expired} onclick={() => decide({ decision: 'deny' }, 'Abgelehnt')}>
      Ablehnen
    </button>
    <button type="button" class="btn primary" disabled={busy || expired} onclick={() => decide({ decision: 'approve' }, 'Erlaubt')}>
      Erlauben
    </button>
  </div>
  <!-- ADR-0029/0026 amendment: one optional "Wofür?" for whichever
       Zeitfreigabe or Sperre button is tapped next. -->
  <label class="purpose-field">
    <span class="hint">Wofür? (optional, für Zeitfreigabe oder Sperre)</span>
    <input
      type="text"
      maxlength="200"
      bind:value={purpose}
      disabled={busy || expired}
      placeholder="z. B. nur Putzaufgaben anlegen"
      enterkeyhint="done"
      autocomplete="off"
      data-source={fromChip ? 'suggested' : 'typed'}
    />
  </label>
  {#if chips.length > 0}
    <!-- TC-172: AI purpose suggestions (model output: text only), for the
         Zeitfreigabe below. A tap only fills the field. -->
    <div class="purpose-suggest" data-testid="purpose-suggest">
      <span class="suggest-label">KI-Vorschlag · für die Zeitfreigabe</span>
      <div class="suggest-chips">
        {#each chips as c (c.key)}
          <button
            type="button"
            class="suggest-chip"
            data-testid={`purpose-chip-${c.key}`}
            aria-pressed={fromChip && purpose.trim() === c.text}
            disabled={busy || expired}
            onclick={() => pick(c.text)}
          >
            <span class="suggest-text"><span class="suggest-kind">{c.label}:</span> {c.text}</span>
          </button>
        {/each}
      </div>
      {#if fromChip}
        <p class="hint suggest-note" data-testid="purpose-suggested-note">KI-Vorschlag übernommen – gilt nur für eine Zeitfreigabe, nicht für eine Sperre.</p>
      {/if}
    </div>
  {/if}
  {#if approval.snoozable}
    <p class="hint snooze-label">Erlauben und für diesen Client nicht mehr fragen bei …</p>
    <div class="scope-row" role="radiogroup" aria-label="Umfang der Zeitfreigabe">
      <label class="scope-option">
        <input type="radio" name={`scope-${approval.id}`} value="tool" bind:group={scope} />
        <span>nur diesem Tool</span>
      </label>
      {#if approval.readOnly}
        <label class="scope-option">
          <input type="radio" name={`scope-${approval.id}`} value="readonly" bind:group={scope} />
          <span>allen Lesetools von {approval.upstream.name}</span>
        </label>
      {/if}
      <label class="scope-option">
        <input type="radio" name={`scope-${approval.id}`} value="upstream" bind:group={scope} />
        <span>allen Tools von {approval.upstream.name}</span>
      </label>
    </div>
    <div class="snooze-row" role="group" aria-label="Erlauben mit Zeitfreigabe">
      <button
        type="button"
        class="btn"
        disabled={busy || expired}
        onclick={() => snooze({ snoozeMinutes: 15 }, '15 Minuten')}>Erlauben · 15 Min. nicht mehr fragen</button
      >
      <button
        type="button"
        class="btn"
        disabled={busy || expired}
        onclick={() => snooze({ snoozeMinutes: 60 }, '1 Stunde')}>Erlauben · 1 Std. nicht mehr fragen</button
      >
      <button
        type="button"
        class="btn"
        disabled={busy || expired}
        onclick={() => snooze({ snoozeUntilMidnight: true }, 'heute')}>Erlauben · bis Mitternacht nicht mehr fragen</button
      >
    </div>
  {/if}
  <p class="hint snooze-label">Ablehnen und nicht mehr fragen bei …</p>
  <div class="scope-row" role="radiogroup" aria-label="Umfang der Sperre">
    <label class="scope-option">
      <input type="radio" name={`deny-scope-${approval.id}`} value="tool" bind:group={denyScope} />
      <span>dieses Tool</span>
    </label>
    <label class="scope-option">
      <input type="radio" name={`deny-scope-${approval.id}`} value="upstream" bind:group={denyScope} />
      <span>ganz {approval.upstream.name}</span>
    </label>
  </div>
  <div class="snooze-row deny-pause-row" role="group" aria-label="Ablehnen und sperren">
    <button
      type="button"
      class="btn danger-outline"
      disabled={busy || expired}
      onclick={() => denyPause({ snoozeMinutes: 15 }, '15 Minuten')}>Ablehnen · 15 Min. sperren</button
    >
    <button
      type="button"
      class="btn danger-outline"
      disabled={busy || expired}
      onclick={() => denyPause({ snoozeMinutes: 60 }, '1 Stunde')}>Ablehnen · 1 Std. sperren</button
    >
    <button
      type="button"
      class="btn danger-outline"
      disabled={busy || expired}
      onclick={() => denyPause({ snoozeUntilMidnight: true }, 'heute')}>Ablehnen · bis Mitternacht sperren</button
    >
  </div>
</article>

<style>
  .purpose-suggest {
    margin: -0.25rem 0 0.5rem;
    min-width: 0;
  }
  .suggest-label {
    display: block;
    font-size: 0.75rem;
    color: var(--muted);
    margin-bottom: 0.25rem;
  }
  .suggest-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    min-width: 0;
  }
  .suggest-chip {
    display: flex;
    align-items: center;
    max-width: 100%;
    min-width: 0;
    min-height: 2.75rem;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--accent-soft);
    border-radius: 999px;
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 0.875rem;
    line-height: 1.25rem;
    text-align: left;
    cursor: pointer;
  }
  .suggest-chip[aria-pressed='true'] {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .suggest-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .suggest-kind {
    font-weight: 600;
  }
  .suggest-note {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
  }
  .purpose-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0.5rem 0;
    min-width: 0;
  }
  .purpose-field input {
    width: 100%;
    min-width: 0;
    font: inherit;
    font-size: 1rem;
    min-height: 2.75rem;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--fg);
  }
  .tool-review {
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .tool-review.attention {
    border-color: var(--warn);
    background: var(--warn-soft);
  }
  .tool-review-head {
    margin: 0;
    font-weight: 600;
  }
  .tool-review-head.ok {
    color: var(--ok);
  }
  .tool-review ul {
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
  }
  .tool-review-label {
    margin: 0.25rem 0 0;
    color: var(--muted);
  }
  .pause-check-note {
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    border: 1px solid var(--warn);
    background: var(--warn-soft);
    color: var(--fg);
    font-size: 0.875rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .pause-check-note.mismatch {
    border-color: var(--danger);
  }
</style>
