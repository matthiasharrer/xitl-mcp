<script lang="ts">
  // #/sitzungen (ADR-0016, TC-59): the user's MCP sessions, newest first, 50
  // per page. A session starts when a client sends `initialize`; clients on the
  // 2026 protocol (or without session support) never show up here.
  import Spinner from '../lib/Spinner.svelte';
  import { api, messageOf, type SessionSummary } from '../lib/api';

  let sessions = $state<SessionSummary[]>([]);
  let nextBefore = $state<string | null>(null);
  let loaded = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function load(more = false) {
    loading = true;
    try {
      const page = await api.listSessions(more ? (nextBefore ?? undefined) : undefined);
      sessions = more ? [...sessions, ...page.sessions] : page.sessions;
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

  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const fmt = (iso: string) => dateTime.format(new Date(iso));
  const infoText = (s: SessionSummary) =>
    s.clientInfo.name ? `${s.clientInfo.name}${s.clientInfo.version ? ` ${s.clientInfo.version}` : ''}` : 'ohne Client-Angabe';
  const callsText = (n: number) => (n === 1 ? '1 Aufruf' : `${n} Aufrufe`);
</script>

<div class="history">
  <a class="back-link" href="#/einstellungen">‹ Einstellungen</a>
  <h2 class="section-title">Sitzungen</h2>
  {#if !loaded}
    <Spinner />
  {:else if loadError && sessions.length === 0}
    <p class="error" role="alert">{loadError}</p>
    <button type="button" class="btn" onclick={() => load()}>Erneut versuchen</button>
  {:else if sessions.length === 0}
    <p class="empty">Noch keine Sitzungen.</p>
  {:else}
    <ul class="list" aria-label="Sitzungen">
      {#each sessions as s (s.id)}
        <li class="item history-item">
          <a class="history-link" href={`#/sitzungen/${s.id}`} data-session={s.id}>
            <span class="item-head">
              <span class="item-name">{s.client.name}</span>
              <span class="chip">{s.endedAt ? 'beendet' : callsText(s.callCount)}</span>
            </span>
            <span class="sub">
              <span>{s.upstream?.name ?? 'Alle Upstreams'} · {infoText(s)}</span>
              <span>seit {fmt(s.createdAt)} · zuletzt {fmt(s.lastSeenAt)}</span>
              <span>
                {s.endedAt ? `${callsText(s.callCount)} · ` : ''}Protokoll {s.protocolVersion ?? '–'}
              </span>
            </span>
          </a>
        </li>
      {/each}
    </ul>
    {#if nextBefore !== null}
      <button type="button" class="btn wide" disabled={loading} onclick={() => load(true)}>{loading ? 'Lädt…' : 'Ältere laden'}</button>
    {/if}
  {/if}
  <p class="hint section-hint">
    Eine Sitzung beginnt, wenn sich ein Client neu anmeldet (<code>initialize</code>). Clients ohne
    Sitzungen erscheinen hier nicht; ihre Aufrufe stehen trotzdem im Verlauf.
  </p>
</div>
