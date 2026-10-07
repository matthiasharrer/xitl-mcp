<script lang="ts">
  // ADR-0031: the advisory review hint of a new or changed tool in Regeln:
  // "Genauer ansehen" with its reasons, or "Unauffällig"; the Clef label;
  // for a changed tool a compact diff (old -> new description, hints,
  // parameters). Everything here is display only; upstream texts are shown
  // as text, never HTML.
  import type { ToolParam, ToolRow } from './api';

  let { tool }: { tool: ToolRow } = $props();

  const r = $derived(tool.review);
  const prev = $derived(tool.previous);

  const typeOf = (p: ToolParam) => {
    if (!p.type) return '';
    try {
      const t = JSON.parse(p.type);
      return Array.isArray(t) ? t.join('|') : String(t);
    } catch {
      return p.type;
    }
  };

  /** Annotation keys whose value differs: "readOnlyHint: true → –". */
  const annotationDiff = $derived.by(() => {
    if (!prev) return [];
    const a = prev.annotations ?? {};
    const b = tool.annotations ?? {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const show = (v: unknown) => (v === undefined ? '–' : JSON.stringify(v));
    return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${show(a[k])} → ${show(b[k])}`);
  });

  /** Parameter lines: "+ recipient (string, Pflicht)", "− id", "~ count: string → number". */
  const paramDiff = $derived.by(() => {
    if (!prev || !prev.parameters || !tool.parameters) return [];
    const before = new Map(prev.parameters.map((p) => [p.name, p]));
    const after = new Map(tool.parameters.map((p) => [p.name, p]));
    const out: string[] = [];
    for (const p of tool.parameters) {
      const o = before.get(p.name);
      const desc = `${typeOf(p)}${p.required ? ', Pflicht' : ''}`;
      if (!o) out.push(`+ ${p.name}${desc ? ` (${desc})` : ''}`);
      else if (o.type !== p.type || o.required !== p.required) out.push(`~ ${p.name}: ${typeOf(o)}${o.required ? ', Pflicht' : ''} → ${desc}`);
    }
    for (const o of prev.parameters) if (!after.has(o.name)) out.push(`− ${o.name}`);
    return out;
  });
  const descChanged = $derived(!!prev && prev.description !== tool.description);
</script>

{#if r.review}
  <div class="review" class:attention={r.attention} data-review={r.attention ? 'attention' : r.pending ? 'pending' : 'ok'}>
    {#if r.attention}
      <p class="review-head">Genauer ansehen</p>
      <ul class="reasons" aria-label="Gründe">
        {#each r.reasons as reason}<li>{reason}</li>{/each}
      </ul>
    {:else if r.pending}
      <p class="review-head muted">KI-Einschätzung läuft…</p>
    {:else}
      <p class="review-head ok">Unauffällig</p>
    {/if}
    {#if r.label}<p class="review-label">{r.label}</p>{/if}
    {#if tool.isChanged && prev}
      <details class="diff" open={r.attention}>
        <summary>Was hat sich geändert?</summary>
        {#if descChanged}
          <p class="diff-title">Beschreibung</p>
          <p class="diff-old">{prev.description ?? '(keine)'}</p>
          <p class="diff-new">{tool.description ?? '(keine)'}</p>
        {/if}
        {#if annotationDiff.length > 0}
          <p class="diff-title">Hinweise</p>
          <ul class="diff-list">{#each annotationDiff as l}<li>{l}</li>{/each}</ul>
        {/if}
        {#if paramDiff.length > 0}
          <p class="diff-title">Parameter</p>
          <ul class="diff-list">{#each paramDiff as l}<li>{l}</li>{/each}</ul>
        {/if}
        {#if !descChanged && annotationDiff.length === 0 && paramDiff.length === 0}
          <p class="hint">Parameter-Schema geändert (Details nicht darstellbar).</p>
        {/if}
      </details>
    {/if}
  </div>
{:else if tool.cosmeticAckAt && prev}
  <details class="review cosmetic">
    <summary>Text nur in Schreibweise geändert, automatisch bestätigt</summary>
    <p class="diff-old">{prev.description ?? '(keine)'}</p>
    <p class="diff-new">{tool.description ?? '(keine)'}</p>
  </details>
{/if}

<style>
  .review {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .review.attention {
    border-color: var(--warn);
    background: var(--warn-soft);
  }
  .review-head {
    margin: 0;
    font-weight: 600;
  }
  .review-head.ok {
    color: var(--ok);
  }
  .review-head.muted {
    color: var(--muted);
  }
  .reasons {
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
  }
  .review-label {
    margin: 0.25rem 0 0;
    color: var(--muted);
  }
  .diff {
    margin-top: 0.375rem;
  }
  .diff summary,
  .cosmetic summary {
    cursor: pointer;
    min-height: 2rem;
    color: var(--muted);
  }
  .diff-title {
    margin: 0.375rem 0 0.125rem;
    font-weight: 600;
  }
  .diff-old,
  .diff-new {
    margin: 0.125rem 0;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    white-space: pre-wrap;
  }
  .diff-old {
    text-decoration: line-through;
    color: var(--muted);
    background: var(--bg);
  }
  .diff-new {
    background: var(--accent-soft);
  }
  .diff-list {
    margin: 0;
    padding-left: 1rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8125rem;
    list-style: none;
  }
</style>
