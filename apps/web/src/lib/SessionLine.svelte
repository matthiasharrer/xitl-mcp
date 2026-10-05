<script lang="ts">
  // A small "Sitzung seit 14:02" line (ADR-0016): which MCP session a call came
  // in on. A link to the session unless it sits inside another link (Verlauf
  // rows). Nothing when the call was sessionless.
  import { sessionSinceText, type SessionRef } from './api';

  let { session, link = true }: { session: SessionRef; link?: boolean } = $props();
</script>

{#if session}
  {#if link}
    <a class="session-line" href={`#/sitzungen/${session.id}`} data-session={session.id}>{sessionSinceText(session.createdAt)}</a>
  {:else}
    <span class="session-line" data-session={session.id}>{sessionSinceText(session.createdAt)}</span>
  {/if}
{/if}
