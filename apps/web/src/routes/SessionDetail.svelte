<script lang="ts">
  // #/sitzungen/<id> (ADR-0016, TC-59, TC-60): one session, its calls, and a
  // "Diagnose" block with what the client sent (header NAMES and `_meta` keys,
  // never values) — the measurement that decides how calls get grouped.
  import Spinner from '../lib/Spinner.svelte';
  import { api, ApiError, decisionPathText, messageOf, OUTCOME_LABEL, type SessionDetail } from '../lib/api';

  let { id }: { id: string } = $props();

  let session = $state<SessionDetail | null>(null);
  let missing = $state(false);
  let loadError = $state<string | null>(null);

  function load() {
    api.getSession(id).then(
      (s) => (session = s),
      (e) => {
        if (e instanceof ApiError && e.status === 404) missing = true;
        else loadError = messageOf(e);
      },
    );
  }
  load();

  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });
  const short = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
  const fmt = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '–');
</script>

<div class="history">
  <a class="back-link" href="#/sitzungen">‹ Sitzungen</a>
  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
  {:else if missing}
    <p class="empty">Diese Sitzung gibt es nicht.</p>
  {:else if !session}
    <Spinner />
  {:else}
    {@const s = session}
    <article class="card audit-detail" aria-label="Sitzung">
      <div class="item-head">
        <span class="item-name">{s.client.name}</span>
        <span class="chip">{s.endedAt ? 'beendet' : 'offen'}</span>
      </div>
      <dl class="facts">
        <dt>Upstream</dt><dd>{s.upstream?.name ?? 'Alle Upstreams'}</dd>
        <dt>Client meldet</dt><dd>{s.clientInfo.name ?? '–'}{s.clientInfo.version ? ` ${s.clientInfo.version}` : ''}</dd>
        <dt>Protokoll</dt><dd>{s.protocolVersion ?? '–'}</dd>
        <dt>Begonnen</dt><dd>{fmt(s.createdAt)}</dd>
        <dt>Zuletzt</dt><dd>{fmt(s.lastSeenAt)}</dd>
        {#if s.endedAt}<dt>Beendet</dt><dd>{fmt(s.endedAt)}</dd>{/if}
        <dt>Aufrufe</dt><dd>{s.callCount}</dd>
      </dl>
    </article>

    <h3 class="section-title session-section">Aufrufe in dieser Sitzung</h3>
    {#if s.entries.length === 0}
      <p class="empty">Keine Tool-Aufrufe.</p>
    {:else}
      <ul class="list" aria-label="Aufrufe in dieser Sitzung">
        {#each s.entries as e (e.id)}
          <li class="item history-item">
            <a class="history-link" href={`#/verlauf/${e.id}`} data-audit={e.id}>
              <span class="item-head">
                <span class="tool-name">{e.tool}</span>
                <span class="chip outcome-{e.outcome.toLowerCase()}">{OUTCOME_LABEL[e.outcome]}</span>
              </span>
              <span class="sub">
                <span>{short.format(new Date(e.receivedAt))}</span>
                <span class="history-path">{decisionPathText(e.decisionPath)}</span>
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}

    <h3 class="section-title session-section">Diagnose</h3>
    <div class="card diagnose" aria-label="Diagnose">
      <p class="hint">Was der Client mitgeschickt hat, nur Namen, keine Werte.</p>
      <dl class="facts">
        <dt>User-Agent</dt><dd class="mono">{s.userAgent ?? '–'}</dd>
      </dl>
      <h4 class="diagnose-title">Header</h4>
      {#if s.headerNames.length === 0}
        <p class="hint">Keine.</p>
      {:else}
        <ul class="name-list" aria-label="Header-Namen">
          {#each s.headerNames as n (n)}<li>{n}</li>{/each}
        </ul>
      {/if}
      <h4 class="diagnose-title"><code>_meta</code> in Tool-Aufrufen</h4>
      {#if s.metaKeys.length === 0}
        <p class="hint">Keine.</p>
      {:else}
        <ul class="name-list" aria-label="_meta-Schlüssel">
          {#each s.metaKeys as n (n)}<li>{n}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
