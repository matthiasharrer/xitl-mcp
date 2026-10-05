<script lang="ts">
  // "Verlauf" (ADR-0008, TC-35): the user's calls, newest first, 50 per page,
  // under day separators and grouped per session / client by time gaps
  // (lib/grouping.ts, TC-75).
  import Spinner from '../lib/Spinner.svelte';
  import SessionLine from '../lib/SessionLine.svelte';
  import { api, decisionPathText, messageOf, OUTCOME_LABEL, type AuditRow } from '../lib/api';
  import { groupByDay } from '../lib/grouping';

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

  const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' });
  const timeSec = new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium' });
  const days = $derived(groupByDay(entries, new Date()));
  const range = (from: Date, to: Date) => (time.format(from) === time.format(to) ? time.format(to) : `${time.format(from)}–${time.format(to)}`);
  const callsText = (n: number) => (n === 1 ? '1 Aufruf' : `${n} Aufrufe`);
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
    {#each days as day (day.key)}
      <section class="history-day" aria-label={day.label} data-day={day.key}>
        <h3 class="day-label">{day.label}</h3>
        {#each day.groups as g (g.key)}
          <div class="call-group" data-group={g.key}>
            <p class="group-head">
              <span class="group-client">{g.clientName ?? 'Client'}</span>
              <span>{range(g.from, g.to)} · {callsText(g.items.length)}</span>
            </p>
            {#if g.session}<SessionLine session={g.session} />{/if}
            <ul class="list" aria-label={`Aufrufe von ${g.clientName ?? 'Client'}`}>
              {#each g.items as e (e.id)}
                <li class="item history-item">
                  <a class="history-link" href={`#/verlauf/${e.id}`} data-audit={e.id}>
                    <span class="item-head">
                      <span class="tool-name">{e.tool}</span>
                      <span class="chip outcome-{e.outcome.toLowerCase()}">{OUTCOME_LABEL[e.outcome]}</span>
                    </span>
                    <span class="sub">
                      <span>{e.upstream?.name ?? '–'} · {timeSec.format(new Date(e.receivedAt))}</span>
                      <span class="history-path">{decisionPathText(e.decisionPath)}</span>
                    </span>
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </section>
    {/each}
    {#if nextBefore !== null}
      <button type="button" class="btn wide" disabled={loading} onclick={() => load(true)}>{loading ? 'Lädt…' : 'Ältere laden'}</button>
    {/if}
  {/if}
</div>

<style>
  .day-label {
    margin: 1.25rem 0 0.5rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .history-day:first-of-type .day-label {
    margin-top: 0.25rem;
  }
  .group-head {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0.75rem 0 0.375rem;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .group-client {
    font-weight: 600;
    color: var(--fg);
    overflow-wrap: anywhere;
  }
</style>
