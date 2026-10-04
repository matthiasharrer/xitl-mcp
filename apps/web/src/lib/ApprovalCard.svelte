<script lang="ts">
  // One held call (ADR-0004): who asks, what, with which arguments, how long
  // it still waits; Ablehnen / Erlauben and the snooze choices (TC-27…30).
  // Arguments come from the (untrusted) agent: shown as text, never as HTML.
  import { onDestroy, untrack } from 'svelte';
  import { api, ApiError, messageOf, type ApprovalDecision, type PendingApproval } from './api';
  import { showToast } from './store.svelte';

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

  const argsText = $derived.by(() => {
    try {
      return JSON.stringify(approval.arguments, null, 2) ?? '';
    } catch {
      return String(approval.arguments);
    }
  });
  const noArgs = $derived(
    approval.arguments === null ||
      (typeof approval.arguments === 'object' && Object.keys(approval.arguments as object).length === 0),
  );

  async function decide(d: ApprovalDecision, done: string) {
    busy = true;
    try {
      const res = await api.decideApproval(approval.id, d);
      showToast(done);
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
  <div class="approval-what">
    <span class="approval-upstream">{approval.upstream.name}</span>
    <span class="tool-name">{approval.tool}</span>
  </div>
  {#if !approval.snoozable}
    <p class="hint approval-new">
      Neues oder geändertes Tool. Prüfe es in den <a href={`#/regeln/${approval.upstream.id}`}>Regeln</a>.
    </p>
  {/if}

  {#if noArgs}
    <p class="hint">Ohne Argumente.</p>
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
    <p class="hint snooze-label">Erlauben und für diesen Client nicht mehr fragen:</p>
    <div class="snooze-row" role="group" aria-label="Erlauben und pausieren">
      <button
        type="button"
        class="btn"
        aria-label="Erlauben, 15 Minuten nicht mehr fragen"
        disabled={busy || expired}
        onclick={() => decide({ decision: 'approve', snoozeMinutes: 15 }, 'Erlaubt, 15 Minuten ohne Nachfrage')}>15 Min.</button
      >
      <button
        type="button"
        class="btn"
        aria-label="Erlauben, 1 Stunde nicht mehr fragen"
        disabled={busy || expired}
        onclick={() => decide({ decision: 'approve', snoozeMinutes: 60 }, 'Erlaubt, 1 Stunde ohne Nachfrage')}>1 Std.</button
      >
      <button
        type="button"
        class="btn"
        aria-label="Erlauben, heute nicht mehr fragen"
        disabled={busy || expired}
        onclick={() => decide({ decision: 'approve', snoozeUntilMidnight: true }, 'Erlaubt, heute ohne Nachfrage')}>Heute</button
      >
    </div>
  {/if}
</article>
