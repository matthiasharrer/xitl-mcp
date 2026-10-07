<script lang="ts">
  // Start = "Freigaben": the user's held calls, live (SSE), newest first, and
  // above them one "Störung" card per upstream that needs the user (ADR-0022).
  import { onDestroy } from 'svelte';
  import ApprovalCard from '../lib/ApprovalCard.svelte';
  import FaultCard from '../lib/FaultCard.svelte';
  import PauseCheckFaultCard from '../lib/PauseCheckFaultCard.svelte';
  import { groupCalls } from '../lib/grouping';
  import Spinner from '../lib/Spinner.svelte';
  import { api, messageOf, type Me, type PendingApproval, type UpstreamFault } from '../lib/api';
  import { openApprovalStream } from '../lib/approvalStream';

  let { me }: { me: Me | null } = $props();

  let list = $state<PendingApproval[]>([]);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let live = $state(true);
  let faults = $state<UpstreamFault[]>([]);
  /** ADR-0029: the AI check of Zeitfreigaben is failing (stream event). */
  let checkFailing = $state(false);

  const loadFaults = () =>
    api.listUpstreamFaults().then(
      (l) => (faults = l),
      () => undefined, // the stream's list follows; a card is a hint, not a gate
    );
  loadFaults();

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
    intent: ({ id, intentStatus, intentTitle, intentSummary, intentRisk, intentLowered }) => {
      list = list.map((p) => (p.id === id ? { ...p, intentStatus, intentTitle, intentSummary, intentRisk, intentLowered } : p));
    },
    upstreams: (l) => (faults = l),
    pausecheck: (s) => (checkFailing = s.failing),
    checked: ({ id, pauseCheck }) => {
      list = list.map((p) => (p.id === id ? { ...p, pauseCheck } : p));
    },
    connected: (ok) => (live = ok),
  });
  onDestroy(close);

  const remove = (id: string) => (list = list.filter((p) => p.id !== id));
  // Grouped per session / client (lib/grouping.ts); the list is newest first.
  const groups = $derived(groupCalls([...list].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))));
</script>

<div class="approvals">
  {#if me}<p class="greeting">Hallo, {me.displayName}</p>{/if}
  <h2 class="section-title">Freigaben</h2>
  {#if !live}
    <p class="hint" role="status">Verbindung unterbrochen, verbinde neu…</p>
  {/if}
  <!-- ADR-0022: faults first; they are not approvals (no decision, no deadline). -->
  {#if checkFailing}
    <PauseCheckFaultCard onoff={() => (checkFailing = false)} />
  {/if}
  {#each faults as fault (fault.id)}
    <FaultCard {fault} onchange={loadFaults} />
  {/each}
  {#if !loaded}
    <Spinner />
  {:else if loadError}
    <p class="error" role="alert">{loadError}</p>
  {:else if list.length === 0}
    <!-- "Nothing open" would be wrong while a fault card asks for something. -->
    {#if faults.length === 0 && !checkFailing}<p class="empty">Keine offenen Freigaben.</p>{/if}
  {:else}
    {#each groups as g (g.key)}
      {#if groups.length > 1}
        <p class="group-head" data-group={g.key}>
          <span class="group-client">{g.clientName}</span>
          <span>{g.items.length === 1 ? '1 Freigabe' : `${g.items.length} Freigaben`}</span>
        </p>
      {/if}
      {#each g.items as approval (approval.id)}
        <ApprovalCard {approval} ondone={remove} />
      {/each}
    {/each}
  {/if}
</div>

<style>
  .group-head {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0.75rem 0 0.375rem;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .group-client {
    font-weight: 600;
    color: var(--fg);
    overflow-wrap: anywhere;
  }
</style>
