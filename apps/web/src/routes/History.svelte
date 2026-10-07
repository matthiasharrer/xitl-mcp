<script lang="ts">
  // "Verlauf" (ADR-0008, TC-35): the user's calls, newest first, 50 per page,
  // under day separators and grouped per session / client by time gaps
  // (lib/grouping.ts, TC-75). With an AI title (TC-126) the title is the
  // row's headline and the tool moves into the meta line.
  import { onDestroy } from 'svelte';
  import Spinner from '../lib/Spinner.svelte';
  import SessionLine from '../lib/SessionLine.svelte';
  import { api, decisionPathText, messageOf, OUTCOME_LABEL, type AuditRow } from '../lib/api';
  import { groupByDay } from '../lib/grouping';
  import { openApprovalStream } from '../lib/approvalStream';
  import { applyLiveRow, mergeFirstPage } from '../lib/historyLive';

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

  // Live (ADR-0028): the approval stream also carries this user's changed audit
  // rows. Every (re)connect starts with a `snapshot`: refetch the first page then,
  // so nothing missed while disconnected stays stale. Rows that arrive while
  // that fetch is in flight are applied on top of its result.
  let refreshing = false;
  let buffered: AuditRow[] = [];
  let fresh = $state<Set<number>>(new Set());
  async function refresh() {
    refreshing = true;
    buffered = [];
    try {
      const page = await api.listAudit();
      const merged = mergeFirstPage(entries, page.entries, page.nextBefore);
      // Older pages the user already loaded stay, and so does their cursor.
      if (page.nextBefore === null || merged.length === page.entries.length) nextBefore = page.nextBefore;
      entries = merged;
      for (const r of buffered) entries = applyLiveRow(entries, nextBefore, r);
      loadError = null;
      loaded = true;
    } catch {
      // keep what is shown; the next event or reconnect tries again
    } finally {
      refreshing = false;
      buffered = [];
    }
  }
  function live(row: AuditRow) {
    if (refreshing) buffered.push(row);
    const isNew = !entries.some((e) => e.id === row.id);
    const next = applyLiveRow(entries, nextBefore, row);
    if (next === entries) return;
    entries = next;
    if (isNew) {
      fresh = new Set(fresh).add(row.id);
      setTimeout(() => {
        const s = new Set(fresh);
        s.delete(row.id);
        fresh = s;
      }, 4000);
    }
  }
  const close = openApprovalStream({
    // Also the first one: it closes the gap between the initial load and the
    // stream being up.
    snapshot: () => void refresh(),
    history: live,
  });
  onDestroy(close);

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
                {@const title = e.intentStatus === 'DONE' ? e.intentTitle : null}
                <li class="item history-item" class:fresh={fresh.has(e.id)}>
                  <a class="history-link" href={`#/verlauf/${e.id}`} data-audit={e.id}>
                    <span class="item-head">
                      {#if title}
                        <span class="call-title" data-testid="call-title">{title}</span>
                      {:else}
                        <span class="tool-name">{e.tool}</span>
                      {/if}
                      <span class="chip outcome-{e.outcome.toLowerCase()}">{OUTCOME_LABEL[e.outcome]}</span>
                    </span>
                    <span class="sub">
                      <span>{#if title}<span class="tool-name tool-mono">{e.tool}</span>{' · '}{/if}{e.upstream?.name ?? '–'} · {timeSec.format(new Date(e.receivedAt))}</span>
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
  .fresh {
    animation: fresh-row 4s ease-out;
  }
  @keyframes fresh-row {
    from {
      background: var(--accent-soft);
    }
    to {
      background: transparent;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fresh {
      animation: none;
    }
  }
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
