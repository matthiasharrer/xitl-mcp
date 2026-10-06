<script lang="ts">
  // The "what" line of a held call (Freigaben card and detail, TC-126): with
  // the AI title, the title is the headline and "tool · Upstream" moves into
  // a smaller meta line. Without one (feature off, failed, no title) it stays
  // the classic "Upstream · tool" line. While the summary is still being made,
  // a placeholder line of the title's height is reserved, so the card does
  // not jump when the title arrives over SSE.
  // The title is model output from agent-controlled input: text only.
  let {
    tool,
    upstream,
    title = null,
    pending = false,
  }: { tool: string; upstream: string; title?: string | null; pending?: boolean } = $props();
</script>

{#if title}
  <div class="call-what titled">
    <span class="call-title" data-testid="call-title">{title}</span>
    <span class="call-meta"><span class="tool-name tool-mono">{tool}</span> · {upstream}</span>
  </div>
{:else}
  {#if pending}<span class="call-title-placeholder" aria-hidden="true"></span>{/if}
  <div class="approval-what">
    <span class="approval-upstream">{upstream}</span>
    <span class="tool-name">{tool}</span>
  </div>
{/if}

<style>
  .call-what {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .call-title,
  .call-title-placeholder {
    display: block;
    font-size: 1.0625rem;
    line-height: 1.4;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .call-title-placeholder {
    width: 60%;
    height: calc(1.0625rem * 1.4);
    border-radius: 0.25rem;
    background: var(--border);
    opacity: 0.6;
  }
  .call-meta {
    font-size: 0.875rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .call-meta .tool-mono {
    font-weight: 400;
  }
</style>
