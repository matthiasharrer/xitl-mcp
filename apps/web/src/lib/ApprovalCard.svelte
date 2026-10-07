<script lang="ts">
  // One held call (ADR-0004): who asks, what, with which arguments, how long
  // it still waits; Ablehnen / Erlauben, the allow-pause choices (TC-27…30)
  // and the deny pause "Ablehnen und nicht mehr fragen" (ADR-0026, TC-125).
  // Arguments come from the (untrusted) agent: shown as text, never as HTML.
  import { onDestroy, untrack } from 'svelte';
  import { api, ApiError, messageOf, type ApprovalDecision, type PendingApproval, type SnoozeScope } from './api';
  import { showToast } from './store.svelte';
  import SessionLine from './SessionLine.svelte';
  import IntentSummary from './IntentSummary.svelte';
  import CallWhat from './CallWhat.svelte';

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
  const snooze = (d: { snoozeMinutes?: number; snoozeUntilMidnight?: boolean }, label: string) =>
    decide({ decision: 'approve', ...d, snoozeScope: scope }, `Erlaubt, ${label} ohne Nachfrage: ${scopeText}`);

  /** ADR-0026: what "Ablehnen und nicht mehr fragen" blocks. */
  let denyScope = $state<'tool' | 'upstream'>('tool');
  const denyScopeText = $derived(denyScope === 'upstream' ? `alle Tools von ${approval.upstream.name}` : approval.tool);
  const denyPause = (d: { snoozeMinutes?: number; snoozeUntilMidnight?: boolean }, label: string) =>
    decide({ decision: 'deny', ...d, snoozeScope: denyScope }, `Abgelehnt, ${label} gesperrt: ${denyScopeText}`);

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
  {#if !approval.snoozable}
    <p class="hint approval-new">
      Neues oder geändertes Tool. Prüfe es in den <a href={`#/regeln/${approval.upstream.id}`}>Regeln</a>.
    </p>
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
