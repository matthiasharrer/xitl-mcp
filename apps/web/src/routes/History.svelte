<script lang="ts">
  // "Verlauf" (ADR-0008, TC-35): the user's calls, newest first, 50 per page.
  import Spinner from '../lib/Spinner.svelte';
  import { api, decisionPathText, messageOf, OUTCOME_LABEL, type AuditRow } from '../lib/api';

  let entries = $state<AuditRow[]>([]);
  let nextBefore = $state<number | null>(null);
  let loaded = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function load(more = false) {
    loading = true;
    try {
      const page = await api.listAudit(more ? (nextBefore ?? undefined) : undefined);
      entries = more ? [...entries, ...page.entries] : page.entries;
      nextBefore = page.nextBefore;
      loadError = null;
    } catch (e) {
      loadError = messageOf(e);
    } finally {
      loaded = true;
      loading = false;
    }
  }
  load();

  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
</script>

<div class="history">
  <h2 class="section-title">Verlauf</h2>
  {#if !loaded}
    <Spinner />
  {:else if loadError && entries.length === 0}
    <p class="error" role="alert">{loadError}</p>
    <button type="button" class="btn" onclick={() => load()}>Erneut versuchen</button>
  {:else if entries.length === 0}
    <p class="empty">Noch keine Aufrufe.</p>
  {:else}
    <ul class="list" aria-label="Verlauf">
      {#each entries as e (e.id)}
        <li class="item history-item">
          <a class="history-link" href={`#/verlauf/${e.id}`} data-audit={e.id}>
            <span class="item-head">
              <span class="tool-name">{e.tool}</span>
              <span class="chip outcome-{e.outcome.toLowerCase()}">{OUTCOME_LABEL[e.outcome]}</span>
            </span>
            <span class="sub">
              <span>{e.upstream?.name ?? '–'} · {e.clientName ?? 'Client'} · {dateTime.format(new Date(e.receivedAt))}</span>
              <span class="history-path">{decisionPathText(e.decisionPath)}</span>
            </span>
          </a>
        </li>
      {/each}
    </ul>
    {#if nextBefore !== null}
      <button type="button" class="btn wide" disabled={loading} onclick={() => load(true)}>{loading ? 'Lädt…' : 'Ältere laden'}</button>
    {/if}
  {/if}
</div>
