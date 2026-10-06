<script lang="ts">
  // The advisory intent summary of a call (ADR-0025): what the local model
  // thinks the call does, with the shown risk (never below the tool's own
  // hint). Model output from agent-controlled input: plain text only (Svelte
  // escapes it; never {@html}), labelled as AI and advisory.
  import type { IntentFields } from './api';

  let {
    intent,
    /** Verlauf: also model and time. */
    meta = null,
  }: {
    intent: IntentFields;
    meta?: { model: string | null; at: string | null } | null;
  } = $props();

  const RISK_LABEL = { read: 'Lesen', write: 'Schreiben', destructive: 'Destruktiv' } as const;
  const time = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
  const metaText = $derived(
    meta ? [meta.model, meta.at ? time.format(new Date(meta.at)) : null].filter(Boolean).join(' · ') : '',
  );
</script>

{#if intent.intentStatus === 'PENDING'}
  <p class="hint intent-pending" role="status">Zusammenfassung wird erstellt…</p>
{:else if intent.intentStatus === 'FAILED'}
  <p class="hint intent-failed">Keine Zusammenfassung</p>
{:else if intent.intentStatus === 'DONE' && intent.intentSummary}
  <section class="intent" aria-label="KI-Zusammenfassung" data-risk={intent.intentRisk}>
    <div class="intent-head">
      <span class="intent-label">KI-Zusammenfassung · beratend</span>
      {#if intent.intentRisk}
        <span class="chip hint-{intent.intentRisk}" data-testid="intent-risk">{RISK_LABEL[intent.intentRisk]}</span>
      {/if}
    </div>
    <p class="intent-text">{intent.intentSummary}</p>
    {#if intent.intentLowered}
      <p class="intent-warn" role="note">KI schätzt das harmloser ein als das Tool selbst</p>
    {/if}
    {#if metaText}<p class="hint intent-meta">{metaText}</p>{/if}
  </section>
{/if}

<style>
  .intent {
    margin: 0.5rem 0;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius);
    background: var(--accent-soft);
    min-width: 0;
  }
  .intent-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .intent-label {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .intent-text {
    margin: 0.375rem 0 0;
    overflow-wrap: anywhere;
    white-space: pre-line;
  }
  .intent-warn {
    margin: 0.375rem 0 0;
    font-size: 0.875rem;
    color: var(--warn);
    font-weight: 600;
  }
  .intent-meta {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
  }
  .intent-pending,
  .intent-failed {
    margin: 0.5rem 0;
    font-size: 0.875rem;
  }
  .chip {
    background: var(--surface);
  }
</style>
