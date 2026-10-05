<script lang="ts">
  // #/freigabe/<id>: one held call, the push notification's deep link
  // (ADR-0009). iPhones show no notification actions, so this page is the
  // whole decision path there. Shows the outcome once the call is resolved.
  import { onDestroy } from 'svelte';
  import ApprovalCard from '../lib/ApprovalCard.svelte';
  import Spinner from '../lib/Spinner.svelte';
  import SessionLine from '../lib/SessionLine.svelte';
  import { api, ApiError, decisionPathText, messageOf, OUTCOME_LABEL, type PendingApproval, type ResolvedApproval } from '../lib/api';
  import { openApprovalStream } from '../lib/approvalStream';

  let { id }: { id: string } = $props();

  let item = $state<PendingApproval | ResolvedApproval | null>(null);
  let missing = $state(false);
  let loadError = $state<string | null>(null);

  async function load() {
    try {
      item = await api.getApproval(id);
      missing = false;
      loadError = null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) missing = true;
      else loadError = messageOf(e);
    }
  }
  load();

  const close = openApprovalStream({ resolved: (ev) => ev.id === id && load() });
  onDestroy(close);

  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });
  const argsText = (v: unknown) => {
    try {
      return JSON.stringify(v, null, 2) ?? '';
    } catch {
      return String(v);
    }
  };
</script>

<div class="approvals">
  <a class="back-link" href="#/">‹ Alle Freigaben</a>
  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
    <button type="button" class="btn" onclick={load}>Erneut versuchen</button>
  {:else if missing}
    <p class="empty">Diese Freigabe gibt es nicht (mehr).</p>
  {:else if !item}
    <Spinner />
  {:else if item.state === 'pending'}
    {#key item.id}<ApprovalCard approval={item} ondone={() => load()} />{/key}
  {:else}
    {@const r = item}
    <article class="approval card resolved" aria-label={`Freigabe: ${r.tool}`}>
      <div class="approval-head">
        <span class="approval-client">{r.clientName ?? 'Client'}</span>
        <span class="chip outcome-{r.outcome.toLowerCase()}">{OUTCOME_LABEL[r.outcome]}</span>
      </div>
      <div class="approval-what">
        <span class="approval-upstream">{r.upstream?.name ?? '–'}</span>
        <span class="tool-name">{r.tool}</span>
      </div>
      <SessionLine session={r.session} />
      <p class="outcome-text">Nicht mehr offen: {decisionPathText(r.decisionPath)}.</p>
      <pre class="args" aria-label="Argumente">{argsText(r.arguments)}</pre>
      <p class="hint">
        Eingegangen {dateTime.format(new Date(r.receivedAt))}{r.decidedAt ? `, entschieden ${dateTime.format(new Date(r.decidedAt))}` : ''}
      </p>
      <a class="btn wide" href={`#/verlauf/${r.auditId}`}>Im Verlauf ansehen</a>
    </article>
  {/if}
</div>
