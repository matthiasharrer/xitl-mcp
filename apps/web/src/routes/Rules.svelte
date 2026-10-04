<script lang="ts">
  // "Regeln" of one upstream (ADR-0004, TC-23/25): its default policy, and per
  // known tool a read/write hint, a "Neu" badge, the choice Standard /
  // Erlauben / Fragen / Verbieten and optional per-client overrides. Every
  // change is saved at once and applies to the next tools/list and tools/call.
  import Spinner from '../lib/Spinner.svelte';
  import {
    api,
    messageOf,
    HINT_LABEL,
    POLICY_LABEL,
    STATUS_LABEL,
    type Policy,
    type ToolRow,
    type ToolsView,
  } from '../lib/api';
  import { showToast } from '../lib/store.svelte';

  let { upstreamId }: { upstreamId: number } = $props();

  let view = $state<ToolsView | null>(null);
  let loadError = $state<string | null>(null);
  let busy = $state(false);
  let refreshing = $state(false);

  const POLICIES: Policy[] = ['ALLOW', 'ASK', 'DENY'];
  const PATH_LABEL: Record<string, string> = {
    'policy:tool': 'eigene Regel',
    'new-tool': 'neues Tool',
    'changed-tool': 'geändertes Tool',
    'policy:upstream-default': 'Standard',
  };

  async function load() {
    try {
      view = await api.getTools(upstreamId);
      loadError = null;
    } catch (e) {
      loadError = messageOf(e);
    }
  }
  load();

  /** Runs one change; the API answers with the whole fresh view. */
  async function apply(change: () => Promise<ToolsView>, done?: string) {
    busy = true;
    try {
      view = await change();
      if (done) showToast(done);
    } catch (e) {
      showToast(messageOf(e), { error: true });
      await load();
    } finally {
      busy = false;
    }
  }

  async function setDefault(policy: Policy) {
    if (!view || view.upstream.defaultPolicy === policy) return;
    busy = true;
    try {
      await api.updateUpstream(upstreamId, { defaultPolicy: policy });
      view = await api.getTools(upstreamId);
      showToast(`Standard: ${POLICY_LABEL[policy]}`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    refreshing = true;
    await apply(() => api.refreshTools(upstreamId), 'Tools aktualisiert');
    refreshing = false;
  }

  const setTool = (t: ToolRow, policy: Policy | null) => apply(() => api.setToolPolicy(upstreamId, t.id, policy));
  const acknowledge = (t: ToolRow) => apply(() => api.acknowledgeTool(upstreamId, t.id));

  function setClient(t: ToolRow, clientId: number, value: string) {
    if (value === '') return apply(() => api.clearClientPolicy(upstreamId, t.id, clientId));
    return apply(() => api.setClientPolicy(upstreamId, t.id, clientId, value as Policy));
  }

  const clientPolicy = (t: ToolRow, clientId: number) => t.clientPolicies.find((p) => p.mcpClientId === clientId)?.policy ?? '';
</script>

<div class="rules">
  <a class="back-link" href="#/einstellungen">‹ Einstellungen</a>

  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
    <button type="button" class="btn" onclick={load}>Erneut versuchen</button>
  {:else if !view}
    <Spinner />
  {:else}
    {@const u = view.upstream}
    <h2 class="rules-title">Regeln für „{u.name}“</h2>
    {#if u.status !== 'CONNECTED'}
      <p class="hint">Status: {STATUS_LABEL[u.status]}. Verbinde den Upstream in den Einstellungen, um seine Tools zu laden.</p>
    {/if}

    <section aria-labelledby="default-title">
      <h3 id="default-title" class="section-title">Standard</h3>
      <div class="segmented" role="radiogroup" aria-label="Standard-Regel">
        {#each POLICIES as p}
          <label class:selected={u.defaultPolicy === p}>
            <input type="radio" name="default-policy" value={p} checked={u.defaultPolicy === p} disabled={busy} onchange={() => setDefault(p)} />
            {POLICY_LABEL[p]}
          </label>
        {/each}
      </div>
      <p class="hint section-hint">Gilt für jedes Tool ohne eigene Regel. Neue Tools werden trotzdem erst gefragt, bis du sie gesehen hast.</p>
    </section>

    <section aria-labelledby="tools-title">
      <div class="section-head">
        <h3 id="tools-title" class="section-title">Tools</h3>
        <button type="button" class="btn" disabled={refreshing || busy} onclick={refresh}>
          {refreshing ? 'Lädt…' : 'Tools aktualisieren'}
        </button>
      </div>

      {#if view.tools.length === 0}
        <p class="empty">Noch keine Tools bekannt. „Tools aktualisieren“ holt sie vom Upstream.</p>
      {:else}
        <ul class="list" aria-label="Tools">
          {#each view.tools as t (t.id)}
            <li class="item tool" data-tool={t.name}>
              <div class="item-head">
                <span class="tool-name">{t.name}</span>
                {#if t.isNew}<span class="badge new">Neu</span>{/if}
                {#if t.isChanged}<span class="badge changed">Geändert</span>{/if}
              </div>
              <div class="chips">
                <span class="chip hint-{t.hint}">{HINT_LABEL[t.hint]}</span>
              </div>
              {#if t.description}<p class="tool-desc">{t.description}</p>{/if}

              <div class="segmented four" role="radiogroup" aria-label={`Regel für ${t.name}`}>
                <label class:selected={t.policy === null}>
                  <input type="radio" name={`tool-${t.id}`} checked={t.policy === null} disabled={busy} onchange={() => setTool(t, null)} />
                  Standard
                </label>
                {#each POLICIES as p}
                  <label class:selected={t.policy === p}>
                    <input type="radio" name={`tool-${t.id}`} checked={t.policy === p} disabled={busy} onchange={() => setTool(t, p)} />
                    {POLICY_LABEL[p]}
                  </label>
                {/each}
              </div>
              <p class="hint effective">Gilt: <strong>{POLICY_LABEL[t.effectivePolicy]}</strong> ({PATH_LABEL[t.path] ?? t.path})</p>

              {#if t.isChanged}
                <p class="hint changed-note">Beschreibung oder Hinweise dieses Tools haben sich geändert. Bis du es ansiehst, wird jeder Aufruf erfragt, auch wenn eine eigene Regel „Erlauben“ sagt („Fragen“ und „Verbieten“ gelten weiter).</p>
              {/if}
              {#if t.isNew || t.isChanged}
                <button type="button" class="btn wide" disabled={busy} onclick={() => acknowledge(t)}>Gesehen, Standard anwenden</button>
              {/if}

              {#if view.clients.length > 0}
                <details class="client-overrides">
                  <summary>
                    Pro Client{t.clientPolicies.length > 0 ? ` (${t.clientPolicies.length} abweichend)` : ''}
                  </summary>
                  {#each view.clients as c (c.id)}
                    <label class="client-row">
                      <span class="client-name">{c.name}</span>
                      <select
                        aria-label={`Regel für ${t.name} bei ${c.name}`}
                        value={clientPolicy(t, c.id)}
                        disabled={busy}
                        onchange={(e) => setClient(t, c.id, e.currentTarget.value)}
                      >
                        <option value="">Wie oben</option>
                        {#each POLICIES as p}<option value={p}>{POLICY_LABEL[p]}</option>{/each}
                      </select>
                    </label>
                  {/each}
                </details>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
