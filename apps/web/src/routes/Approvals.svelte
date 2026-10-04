<script lang="ts">
  // Start = "Freigaben": the user's held calls, live (SSE), oldest first.
  import { onDestroy } from 'svelte';
  import ApprovalCard from '../lib/ApprovalCard.svelte';
  import Spinner from '../lib/Spinner.svelte';
  import { api, messageOf, type Me, type PendingApproval } from '../lib/api';
  import { openApprovalStream } from '../lib/approvalStream';

  let { me }: { me: Me | null } = $props();

  let list = $state<PendingApproval[]>([]);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let live = $state(true);

  // First paint from the plain list; the stream's snapshot then takes over.
  api.listApprovals().then(
    (l) => {
      list = l;
      loaded = true;
    },
    (e) => {
      loadError = messageOf(e);
      loaded = true;
    },
  );

  const close = openApprovalStream({
    snapshot: (l) => {
      list = l;
      loaded = true;
      loadError = null;
    },
    pending: (call) => {
      if (!list.some((p) => p.id === call.id)) list = [...list, call];
    },
    resolved: ({ id }) => {
      list = list.filter((p) => p.id !== id);
    },
    connected: (ok) => (live = ok),
  });
  onDestroy(close);

  const remove = (id: string) => (list = list.filter((p) => p.id !== id));
</script>

<div class="approvals">
  {#if me}<p class="greeting">Hallo, {me.displayName}</p>{/if}
  <h2 class="section-title">Freigaben</h2>
  {#if !live}
    <p class="hint" role="status">Verbindung unterbrochen, verbinde neu…</p>
  {/if}
  {#if !loaded}
    <Spinner />
  {:else if loadError}
    <p class="error" role="alert">{loadError}</p>
  {:else if list.length === 0}
    <p class="empty">Keine offenen Freigaben.</p>
  {:else}
    {#each list as approval (approval.id)}
      <ApprovalCard {approval} ondone={remove} />
    {/each}
  {/if}
</div>
