<script lang="ts">
  // ADR-0040: "Sitzung abcd1234…" / "Neue Sitzung" (small secondary line).
  import { upstreamSessionText } from './upstreamSession';
  let { handle }: { handle: string | null | undefined } = $props();
  const text = $derived(upstreamSessionText(handle));
</script>

{#if text}<span class="session-line" data-testid="upstream-session">{text}</span>{/if}
