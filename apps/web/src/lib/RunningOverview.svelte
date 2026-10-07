<script lang="ts">
  // "Läuft gerade" (TC-178…183, Matthias 2026-10-07): the user's active
  // time-based decisions at the top of Freigaben. All live Zeitfreigaben and
  // Sperren across upstreams and accesses, plus paused accesses and paused
  // upstreams (ADR-0033, TC-200: "Upstream pausiert", resumed one by one,
  // "Alle beenden" leaves them paused). Collapsed to
  // one line by default (remembered per device), absent when nothing runs.
  // Ending one reuses the per-upstream DELETE and the access PATCH; "Alle
  // beenden" is one user-scoped call. Live: the parent bumps `refresh` on the
  // stream's `running` ping (and on every snapshot = reconnect); expiry by
  // time is handled here with a minute-granular clock.
  import { onDestroy } from 'svelte';
  import { api, ApiError, messageOf, type Running, type RunningPause } from './api';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { endAllMessage, kindText, pauseWhat, remainingText, runningSummary, sinceText } from './pauses';
  import { showToast } from './store.svelte';

  let { refresh = 0 }: { refresh?: number } = $props();

  const KEY = 'xitl.running.open';
  const readOpen = () => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  };
  let open = $state(readOpen());
  function toggle() {
    open = !open;
    try {
      localStorage.setItem(KEY, open ? '1' : '0');
    } catch {
      // per-device convenience only
    }
  }

  let data = $state<Running | null>(null);
  let busy = $state(false);
  let confirming = $state(false);
  let now = $state(new Date());

  async function load() {
    try {
      data = await api.getRunning();
    } catch {
      // A hint, not a gate: keep what we had; the next ping retries.
    }
  }
  $effect(() => {
    void refresh;
    load();
  });

  // Minute-granular countdown; an entry whose end passed disappears here and
  // the next fetch confirms it.
  const timer = setInterval(() => {
    now = new Date();
    if (data?.pauses.some((p) => new Date(p.until) <= now)) load();
  }, 15_000);
  onDestroy(() => clearInterval(timer));

  const live = $derived((data?.pauses ?? []).filter((p) => new Date(p.until).getTime() > now.getTime()));
  const paused = $derived(data?.paused ?? []);
  const pausedUpstreams = $derived(data?.pausedUpstreams ?? []);
  const allows = $derived(live.filter((p) => p.effect === 'ALLOW').length);
  const denies = $derived(live.length - allows);
  const summary = $derived(runningSummary(allows, denies, paused.length, live[0]?.until ?? null, now, pausedUpstreams.length));

  async function end(p: RunningPause) {
    busy = true;
    try {
      await api.liftPause(p.upstream.id, p.id);
      showToast(p.effect === 'ALLOW' ? 'Zeitfreigabe beendet' : 'Sperre aufgehoben');
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
      await load();
    }
  }

  async function resume(c: { id: number; name: string }) {
    busy = true;
    try {
      await api.setClientPaused(c.id, false);
      showToast(`„${c.name}“ fortgesetzt`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
      await load();
    }
  }

  /** ADR-0033: resume a paused upstream for every client. */
  async function resumeUpstream(u: { id: number; name: string }) {
    busy = true;
    try {
      await api.setUpstreamPaused(u.id, false);
      showToast(`„${u.name}“ fortgesetzt`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
      await load();
    }
  }

  async function endAll() {
    confirming = false;
    busy = true;
    try {
      const r = await api.endAllPauses();
      showToast(r.ended === 1 ? '1 Eintrag beendet' : `${r.ended} Einträge beendet`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
      await load();
    }
  }
</script>

{#if summary}
  <section class="running" aria-label="Läuft gerade" data-testid="running">
    <button type="button" class="running-head" aria-expanded={open} onclick={toggle} data-testid="running-summary">
      <span class="running-text">{summary}</span>
      <span class="running-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
    {#if open}
      <ul class="running-list" aria-label="Aktive Zeitfreigaben, Sperren, pausierte Zugänge und Upstreams">
        {#each live as p (p.id)}
          <li class="running-row" data-running-pause={p.id} data-effect={p.effect}>
            <div class="running-main">
              <p class="running-line">
                <span class="chip pause-{p.effect.toLowerCase()}">{kindText(p)}</span>
                <span class="running-what">{pauseWhat(p, p.upstream.name)}</span>
              </p>
              <p class="hint running-meta">{p.client.name} · {remainingText(p.until, now)}</p>
              {#if p.purpose}
                <p class="hint running-purpose">Wofür: {p.purpose}{#if p.purposeSource === 'suggested'}{' '}(Vorschlag){/if}</p>
              {/if}
            </div>
            <button
              type="button"
              class="btn"
              disabled={busy}
              onclick={() => end(p)}
              aria-label={`${p.effect === 'ALLOW' ? 'Zeitfreigabe beenden' : 'Sperre aufheben'}: ${pauseWhat(p, p.upstream.name)}, ${p.client.name}`}
              >{p.effect === 'ALLOW' ? 'Beenden' : 'Aufheben'}</button
            >
          </li>
        {/each}
        {#each paused as c (c.id)}
          <li class="running-row" data-running-client={c.id}>
            <div class="running-main">
              <p class="running-line">
                <span class="chip pause-client">Zugang pausiert</span>
                <span class="running-what">{c.name}</span>
              </p>
              <p class="hint running-meta">{sinceText(c.pausedAt, now)}</p>
            </div>
            <button type="button" class="btn" disabled={busy} onclick={() => resume(c)} aria-label={`Zugang fortsetzen: ${c.name}`}>Fortsetzen</button>
          </li>
        {/each}
        {#each pausedUpstreams as u (u.id)}
          <li class="running-row" data-running-upstream={u.id}>
            <div class="running-main">
              <p class="running-line">
                <span class="chip pause-client">Upstream pausiert</span>
                <span class="running-what">{u.name}</span>
              </p>
              <p class="hint running-meta">{sinceText(u.pausedAt, now)}</p>
            </div>
            <button type="button" class="btn" disabled={busy} onclick={() => resumeUpstream(u)} aria-label={`Upstream fortsetzen: ${u.name}`}>Fortsetzen</button>
          </li>
        {/each}
      </ul>
      {#if live.length > 0}
        <button type="button" class="btn danger-outline wide running-all" disabled={busy} onclick={() => (confirming = true)}>Alle beenden</button>
      {/if}
    {/if}
  </section>
{/if}

{#if confirming}
  <ConfirmDialog
    title="Alle beenden?"
    message={endAllMessage(allows, denies, paused.length, pausedUpstreams.length)}
    confirmLabel="Alle beenden"
    onconfirm={endAll}
    oncancel={() => (confirming = false)}
  />
{/if}

<style>
  .running {
    margin: 0 0 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    min-width: 0;
  }
  .running-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    min-height: var(--tap);
    padding: 0.375rem 0.75rem;
    border: 0;
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 0.875rem;
    text-align: left;
    cursor: pointer;
  }
  .running-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-width: 0;
  }
  .running-caret {
    flex: none;
    color: var(--muted);
  }
  .running-list {
    list-style: none;
    margin: 0;
    padding: 0 0.75rem;
  }
  .running-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--border);
    min-width: 0;
  }
  .running-main {
    flex: 1;
    min-width: 0;
  }
  .running-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
  }
  .running-what {
    font-weight: 600;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .running-meta,
  .running-purpose {
    margin: 0.125rem 0 0;
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .running-all {
    margin: 0.25rem 0.75rem 0.75rem;
    width: calc(100% - 1.5rem);
  }
  /* Same colours as Rules' pause chips and Settings' "pausiert" chip. */
  .chip.pause-allow {
    color: var(--ok);
    border-color: var(--ok);
  }
  .chip.pause-deny {
    color: var(--danger);
    border-color: var(--danger);
  }
  .chip.pause-client {
    color: var(--warn);
    border-color: var(--warn);
    background: var(--warn-soft);
  }
  .running-row .btn {
    flex: none;
  }
</style>
