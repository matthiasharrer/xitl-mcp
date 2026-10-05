<script lang="ts">
  // #/verlauf/<id>: one audit entry with arguments and the result excerpt.
  import Spinner from '../lib/Spinner.svelte';
  import SessionLine from '../lib/SessionLine.svelte';
  import { api, ApiError, decisionPathText, messageOf, OUTCOME_LABEL, POLICY_LABEL, type AuditDetail } from '../lib/api';

  let { id }: { id: number } = $props();

  let entry = $state<AuditDetail | null>(null);
  let missing = $state(false);
  let loadError = $state<string | null>(null);

  function load() {
    api.getAudit(id).then(
      (e) => (entry = e),
      (e) => {
        if (e instanceof ApiError && e.status === 404) missing = true;
        else loadError = messageOf(e);
      },
    );
  }
  load();

  const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });
  const fmt = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '–');
  const argsText = (v: unknown) => {
    try {
      return JSON.stringify(v, null, 2) ?? '';
    } catch {
      return String(v);
    }
  };
</script>

<div class="history">
  <a class="back-link" href="#/verlauf">‹ Verlauf</a>
  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
  {:else if missing}
    <p class="empty">Diesen Eintrag gibt es nicht.</p>
  {:else if !entry}
    <Spinner />
  {:else}
    {@const e = entry}
    <article class="card audit-detail" aria-label={`Aufruf: ${e.tool}`}>
      <div class="item-head">
        <span class="tool-name">{e.tool}</span>
        <span class="chip outcome-{e.outcome.toLowerCase()}">{OUTCOME_LABEL[e.outcome]}</span>
      </div>
      <dl class="facts">
        <dt>Upstream</dt><dd>{e.upstream?.name ?? '–'}</dd>
        <dt>Endpunkt</dt><dd>{e.endpoint}</dd>
        <dt>Client</dt><dd>{e.clientName ?? '–'}</dd>
        <dt>Entscheidung</dt><dd>{decisionPathText(e.decisionPath)}</dd>
        <dt>Regel</dt><dd>{POLICY_LABEL[e.policy]}</dd>
        <dt>Eingegangen</dt><dd>{fmt(e.receivedAt)}</dd>
        <dt>Entschieden</dt><dd>{fmt(e.decidedAt)}</dd>
        <dt>Fertig</dt><dd>{fmt(e.finishedAt)}</dd>
      </dl>
      <SessionLine session={e.session} />
      <h3 class="section-title">Argumente</h3>
      <pre class="args" aria-label="Argumente">{argsText(e.arguments)}</pre>
      <h3 class="section-title">Ergebnis{e.isError ? ' (Fehler)' : ''}</h3>
      {#if e.resultText}
        <pre class="args result" aria-label="Ergebnis">{e.resultText}</pre>
      {:else}
        <p class="hint">Kein Ergebnis.</p>
      {/if}
      <details class="diagnose" aria-label="Diagnose">
        <summary>Diagnose</summary>
        <p class="hint">
          Was der Client bei diesem Aufruf mitgeschickt hat: Header nur als Namen; Werte nur von
          User-Agent, Protokoll, x-anthropic-client und den Trace-Kennungen.
        </p>
        <dl class="facts">
          <dt>Protokoll</dt><dd class="mono">{e.diagnostics.protocolVersion ?? '–'}</dd>
          <dt>Client meldet</dt><dd>{e.diagnostics.clientInfo ?? '–'}</dd>
          <dt>User-Agent</dt><dd class="mono">{e.diagnostics.userAgent ?? '–'}</dd>
          <dt>x-anthropic-client</dt><dd class="mono">{e.diagnostics.anthropicClient ?? '–'}</dd>
          <dt>Trace</dt><dd class="mono trace" data-testid="trace-id">{e.diagnostics.traceId ?? '–'}</dd>
          <dt>Cloud-Trace</dt><dd class="mono trace">{e.diagnostics.cloudTraceId ?? '–'}</dd>
        </dl>
        <h4 class="diagnose-title">Header</h4>
        {#if e.diagnostics.headerNames.length === 0}
          <p class="hint">Keine.</p>
        {:else}
          <ul class="name-list" aria-label="Header-Namen">
            {#each e.diagnostics.headerNames as n (n)}<li>{n}</li>{/each}
          </ul>
        {/if}
        <h4 class="diagnose-title"><code>_meta</code></h4>
        {#if e.diagnostics.metaKeys.length === 0}
          <p class="hint">Keine.</p>
        {:else}
          <ul class="name-list" aria-label="_meta-Schlüssel">
            {#each e.diagnostics.metaKeys as n (n)}<li>{n}</li>{/each}
          </ul>
        {/if}
      </details>
    </article>
  {/if}
</div>
