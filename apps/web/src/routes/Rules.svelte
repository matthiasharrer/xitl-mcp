<script lang="ts">
  // "Regeln" of one upstream (ADR-0004, TC-23/25): its default policy, and per
  // known tool a read/write hint, a "Neu" badge, the choice Standard /
  // Erlauben / Fragen / Verbieten and optional per-client overrides. Every
  // change is saved at once and applies to the next tools/list and tools/call.
  // "Aktive Pausen" (ADR-0026, TC-125): live allow and deny pauses of any
  // client on this upstream; lifting is the only edit.
  // "Gilt für" (ADR-0032, TC-192): "Alle Clients" is the view above; one
  // client shows that client's default for this upstream (Voreinst. / … /
  // Verbieten = hidden) and per tool its EFFECTIVE policy and source, as the
  // API computes it (`forClient`, never recomputed here); the row control
  // edits that client's tool rule. The choice lives in the URL hash
  // (`#/regeln/<id>?client=<id>`), so it survives a reload.
  import Spinner from '../lib/Spinner.svelte';
  import ToolReview from '../lib/ToolReview.svelte';
  import {
    api,
    ApiError,
    messageOf,
    HINT_LABEL,
    POLICY_LABEL,
    POLICIES,
    STATUS_LABEL,
    type Me,
    type Pause,
    type Policy,
    type ToolRow,
    type ToolsView,
  } from '../lib/api';
  import { showToast } from '../lib/store.svelte';
  import { scopeText, untilText } from '../lib/pauses';

  let { upstreamId }: { upstreamId: number } = $props();

  /** The selected client (`?client=` in the hash), null = "Alle Clients". */
  function clientFromHash(): number | null {
    const query = location.hash.split('?')[1] ?? '';
    const m = /(?:^|&)client=(\d{1,9})(?:&|$)/.exec(query);
    return m ? Number(m[1]) : null;
  }
  let scope = $state<number | null>(clientFromHash());
  function writeScope(id: number | null) {
    const base = location.hash.split('?')[0];
    try {
      history.replaceState(history.state, '', id === null ? base : `${base}?client=${id}`);
    } catch {
      /* the selection just isn't kept across reloads */
    }
  }

  let view = $state<ToolsView | null>(null);
  let pauses = $state<Pause[]>([]);
  let loadError = $state<string | null>(null);
  let busy = $state(false);
  let refreshing = $state(false);

  // ADR-0030: the Auto-Regel of this upstream (one text, used by every AUTO
  // rule here), "Vorschlag" and "Mit Verlauf testen" (both change nothing).
  let me = $state<Me | null>(null);
  api.me().then((m) => (me = m), () => undefined);
  let ruleText = $state('');
  let ruleLoadedFor = $state<string | null | undefined>(undefined);
  $effect(() => {
    const stored = view?.upstream.autoRule ?? null;
    if (view && ruleLoadedFor !== stored) {
      ruleText = stored ?? '';
      ruleLoadedFor = stored;
    }
  });
  const ruleDirty = $derived(view !== null && ruleText.trim() !== (view.upstream.autoRule ?? ''));
  const usesAuto = $derived(
    !!view &&
      (view.upstream.defaultPolicy === 'AUTO' || view.tools.some((t) => t.policy === 'AUTO' || t.clientPolicies.some((cp) => cp.policy === 'AUTO'))),
  );
  let drafting = $state(false);

  async function saveRule() {
    busy = true;
    try {
      const u = await api.updateUpstream(upstreamId, { autoRule: ruleText.trim() || null });
      if (view) view = { ...view, upstream: { ...view.upstream, autoRule: u.autoRule } };
      showToast(u.autoRule ? 'Auto-Regel gespeichert' : 'Auto-Regel gelöscht');
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
    }
  }

  async function suggest() {
    drafting = true;
    try {
      const { draft } = await api.draftAutoRule(upstreamId);
      ruleText = draft;
      showToast('Vorschlag eingefügt – prüfen und speichern');
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      drafting = false;
    }
  }

  type TestRow = { id: number; tool: string; receivedAt: string; result: 'pass' | 'below' | 'error' | null; score: number | null };
  let testRows = $state<TestRow[] | null>(null);
  let testCtrl = $state<AbortController | null>(null);
  const testDone = $derived(testRows ? testRows.filter((r) => r.result !== null).length : 0);

  async function runTest() {
    const rule = ruleText.trim();
    if (!rule) return;
    const ctrl = new AbortController();
    testCtrl = ctrl;
    try {
      const h = await api.autoRuleHistory(upstreamId);
      testRows = h.entries.map((e) => ({ id: e.id, tool: e.tool, receivedAt: e.receivedAt, result: null, score: null }));
      // Sequential, one row at a time; "Abbrechen" stops after the current one.
      for (let i = 0; i < testRows.length; i++) {
        if (ctrl.signal.aborted) break;
        const r = await api.testAutoRule(upstreamId, rule, testRows[i]!.id, ctrl.signal);
        testRows[i] = { ...testRows[i]!, result: r.result, score: r.score };
      }
    } catch (e) {
      if (!ctrl.signal.aborted) showToast(messageOf(e), { error: true });
    } finally {
      if (testCtrl === ctrl) testCtrl = null;
    }
  }
  const stopTest = () => testCtrl?.abort();
  const score2 = (n: number | null) => (n === null ? '' : n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const shortTime = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const PATH_LABEL: Record<string, string> = {
    'policy:tool': 'eigene Regel',
    'new-tool': 'neues Tool',
    'changed-tool': 'geändertes Tool',
    'policy:upstream-default': 'Standard',
    'client-hidden': 'für diesen Client verborgen',
    'policy:client-upstream': 'Client-Voreinstellung',
  };
  /** ADR-0032: the source of a client's effective policy ("Erlauben · Tool-Regel"). */
  const SOURCE_LABEL: Record<string, string> = {
    'policy:client': 'Client-Regel',
    'policy:tool': 'Tool-Regel',
    'policy:client-upstream': 'Client-Voreinst.',
    'policy:upstream-default': 'Upstream-Voreinst.',
    'client-hidden': 'Client-Voreinst.',
    'new-tool': 'neu',
    'changed-tool': 'geändert',
  };
  const forClientText = (f: NonNullable<ToolRow['forClient']>) =>
    `${f.path === 'client-hidden' ? 'Verborgen' : POLICY_LABEL[f.policy] ?? f.policy} · ${SOURCE_LABEL[f.path] ?? f.path}`;

  /** The tools view for the current scope (with `forClient` for one client). */
  async function fetchView(): Promise<ToolsView> {
    if (scope === null) return api.getTools(upstreamId);
    try {
      return await api.getTools(upstreamId, scope);
    } catch (e) {
      // The client is gone (revoked) or not one of ours: back to "Alle Clients".
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      scope = null;
      writeScope(null);
      return api.getTools(upstreamId);
    }
  }

  async function load() {
    try {
      [view, pauses] = await Promise.all([fetchView(), api.listPauses(upstreamId)]);
      loadError = null;
    } catch (e) {
      loadError = messageOf(e);
    }
  }
  load();

  async function choose(id: number | null) {
    if (scope === id) return;
    scope = id;
    writeScope(id);
    busy = true;
    try {
      view = await fetchView();
    } catch (e) {
      showToast(messageOf(e), { error: true });
    } finally {
      busy = false;
    }
  }

  const selected = $derived(view && scope !== null ? (view.clients.find((c) => c.id === scope) ?? null) : null);
  const defaultOf = (clientId: number) => view?.clientDefaults.find((d) => d.mcpClientId === clientId)?.policy ?? null;
  const selectedDefault = $derived(selected ? defaultOf(selected.id) : null);
  const clientName = (id: number) => view?.clients.find((c) => c.id === id)?.name ?? '';

  async function setClientDefault(policy: Policy | null) {
    if (!selected || selectedDefault === policy) return;
    const name = selected.name;
    await apply(
      () => api.setClientDefault(upstreamId, selected.id, policy),
      policy === null ? `${name}: Voreinst.` : policy === 'DENY' ? `Für ${name} verborgen` : `${name}: ${POLICY_LABEL[policy]}`,
    );
  }


  async function lift(p: Pause) {
    busy = true;
    try {
      pauses = await api.liftPause(upstreamId, p.id);
      showToast(p.effect === 'ALLOW' ? 'Zeitfreigabe beendet' : 'Sperre aufgehoben');
    } catch (e) {
      showToast(messageOf(e), { error: true });
      pauses = await api.listPauses(upstreamId).catch(() => pauses);
    } finally {
      busy = false;
    }
  }

  /** Runs one change; the API answers with the whole fresh view. */
  async function apply(change: () => Promise<ToolsView>, done?: string) {
    busy = true;
    try {
      view = await change();
      // The answer has no `forClient`: fetch the client view again.
      if (scope !== null) view = await fetchView();
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
      view = await fetchView();
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

  /** ADR-0031: tools to look at first (attention), then the other new or
   * changed ones, then the rest by name (the API's order). */
  const rank = (t: ToolRow) => (t.review.review ? (t.review.attention ? 0 : 1) : 2);
  const sortedTools = $derived(view ? [...view.tools].sort((a, b) => rank(a) - rank(b)) : []);
  const unremarkableCount = $derived(view ? view.tools.filter((t) => t.review.review && !t.review.attention && !t.review.pending).length : 0);

  async function acknowledgeUnremarkable() {
    busy = true;
    try {
      const res = await api.acknowledgeUnremarkable(upstreamId);
      view = res.view;
      showToast(res.acknowledged === 1 ? '1 Tool bestätigt' : `${res.acknowledged} Tools bestätigt`);
    } catch (e) {
      showToast(messageOf(e), { error: true });
      await load();
    } finally {
      busy = false;
    }
  }

  const setTool = (t: ToolRow, policy: Policy | null) => apply(() => api.setToolPolicy(upstreamId, t.id, policy));
  const acknowledge = (t: ToolRow) => apply(() => api.acknowledgeTool(upstreamId, t.id));

  function setClient(t: ToolRow, clientId: number, value: string) {
    if (value === '') return apply(() => api.clearClientPolicy(upstreamId, t.id, clientId));
    return apply(() => api.setClientPolicy(upstreamId, t.id, clientId, value as Policy));
  }

  const clientPolicy = (t: ToolRow, clientId: number) => t.clientPolicies.find((p) => p.mcpClientId === clientId)?.policy ?? '';
  const clientMasked = (t: ToolRow, clientId: number) => t.clientPolicies.find((p) => p.mcpClientId === clientId)?.masked === true;
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

    {#if view.clients.length > 0}
      <section aria-labelledby="scope-title">
        <h3 id="scope-title" class="section-title">Gilt für</h3>
        <div class="scope-switch" role="radiogroup" aria-label="Gilt für">
          <label class:selected={scope === null}>
            <input type="radio" name="rules-scope" checked={scope === null} disabled={busy} onchange={() => choose(null)} />
            Alle Clients
          </label>
          {#each view.clients as c (c.id)}
            <label class:selected={scope === c.id} data-scope-client={c.id}>
              <input type="radio" name="rules-scope" checked={scope === c.id} disabled={busy} onchange={() => choose(c.id)} />
              <span class="scope-name">{c.name}</span>
              {#if c.paused}<span class="chip paused" data-testid="scope-paused">pausiert</span>{/if}
              {#if defaultOf(c.id) === 'DENY'}<span class="chip hidden-chip">verborgen</span>{/if}
            </label>
          {/each}
        </div>
      </section>
    {/if}

    {#if selected}
      <section aria-labelledby="client-default-title" data-testid="client-default">
        <h3 id="client-default-title" class="section-title">Voreinstellung für {selected.name}</h3>
        <div class="segmented five" role="radiogroup" aria-label={`Voreinstellung für ${selected.name}`}>
          <label class:selected={selectedDefault === null}>
            <input type="radio" name="client-default" checked={selectedDefault === null} disabled={busy} onchange={() => setClientDefault(null)} />
            Voreinst.
          </label>
          {#each POLICIES as p}
            <label class:selected={selectedDefault === p}>
              <input type="radio" name="client-default" checked={selectedDefault === p} disabled={busy} onchange={() => setClientDefault(p)} />
              {POLICY_LABEL[p]}
            </label>
          {/each}
        </div>
        <p class="hint section-hint">Voreinst. = Standard des Upstreams ({POLICY_LABEL[u.defaultPolicy]}).</p>
        <p class="hint section-hint precedence" data-testid="precedence">
          Client-Regel &gt; Tool-Regel &gt; Client-Voreinst. &gt; Upstream-Voreinst. · Verbieten als Voreinstellung verbirgt alles
        </p>
        {#if selectedDefault === 'DENY'}
          <p class="hidden-note" role="status" data-testid="hidden-note">Für {selected.name} unsichtbar: keine Tools, kein Abschnitt in den Anweisungen</p>
        {/if}
      </section>
    {:else}
    <section aria-labelledby="default-title">
      <h3 id="default-title" class="section-title">Standard</h3>
      <div class="segmented four" role="radiogroup" aria-label="Standard-Regel">
        {#each POLICIES as p}
          <label class:selected={u.defaultPolicy === p}>
            <input type="radio" name="default-policy" value={p} checked={u.defaultPolicy === p} disabled={busy} onchange={() => setDefault(p)} />
            {POLICY_LABEL[p]}
          </label>
        {/each}
      </div>
      <p class="hint section-hint">Gilt für jedes Tool ohne eigene Regel. Neue Tools werden trotzdem erst gefragt, bis du sie gesehen hast.</p>
      {#if view.clientDefaults.length > 0}
        <p class="hint section-hint" data-testid="client-defaults">
          Eigene Voreinstellung: {view.clientDefaults.map((d) => `${clientName(d.mcpClientId)} (${d.policy === 'DENY' ? 'verborgen' : POLICY_LABEL[d.policy]})`).join(', ')}
        </p>
      {/if}
    </section>
    {/if}

    {#if usesAuto}
      <section aria-labelledby="auto-title" class="auto-rule">
        <h3 id="auto-title" class="section-title">Auto-Regel</h3>
        <p class="hint section-hint auto-note">
          Schreib in deinen Worten, was ohne Nachfrage in Ordnung ist. Eine KI prüft jeden Aufruf mit „Auto“ dagegen; was sie
          nicht eindeutig gedeckt sieht, wird gefragt. <strong>Auto ist schwächer als Fragen:</strong> die KI urteilt über
          Argumente, die der Agent schickt. Für heikle Tools lieber „Fragen“.
        </p>
        {#if me && (!me.pauseCheckAvailable || !me.pauseCheck)}
          <p class="hint section-hint" data-testid="auto-off">KI-Prüfung ist aus: „Auto“ fragt wie „Fragen“.</p>
        {/if}
        <label class="auto-label" for="auto-rule-text">Was ist ohne Nachfrage ok?</label>
        <textarea
          id="auto-rule-text"
          rows="4"
          maxlength="1000"
          bind:value={ruleText}
          disabled={busy}
          placeholder="z. B. Lesen und Suchen ist ok. Neue Einträge anlegen ist ok. Löschen nur mit Rückfrage."
        ></textarea>
        <p class="hint auto-count">{ruleText.length}/1000{#if !view.upstream.autoRule} · noch keine Regel gespeichert: „Auto“ fragt wie „Fragen“{/if}</p>
        <div class="auto-actions">
          <button type="button" class="btn primary" disabled={busy || !ruleDirty} onclick={saveRule}>Speichern</button>
          {#if me?.autoDraftAvailable}
            <button type="button" class="btn" disabled={busy || drafting} onclick={suggest}>{drafting ? 'Schreibt…' : 'Vorschlag'}</button>
          {/if}
          {#if me?.pauseCheckAvailable && me.pauseCheck}
            {#if testCtrl}
              <button type="button" class="btn" onclick={stopTest}>Abbrechen</button>
            {:else}
              <button type="button" class="btn" disabled={busy || !ruleText.trim()} onclick={runTest}>Mit Verlauf testen</button>
            {/if}
          {/if}
        </div>
        {#if testRows}
          <div class="auto-test" aria-label="Test mit dem Verlauf">
            <p class="hint">
              {testRows.length === 0
                ? 'Noch keine Aufrufe im Verlauf.'
                : `${testDone}/${testRows.length} geprüft: ${testRows.filter((r) => r.result === 'pass').length} würden durchgehen, ${testRows.filter((r) => r.result === 'below' || r.result === 'error').length} würden gefragt.`}
              Nichts wurde geändert.
            </p>
            <ul class="auto-test-list">
              {#each testRows as r (r.id)}
                <li data-test-row={r.id} data-result={r.result ?? 'open'}>
                  <span class="tool-name">{r.tool}</span>
                  <span class="auto-test-time">{shortTime.format(new Date(r.receivedAt))}</span>
                  <span class="chip auto-{r.result ?? 'open'}"
                    >{r.result === 'pass' ? `durch ${score2(r.score)}` : r.result === 'below' ? `fragen ${score2(r.score)}` : r.result === 'error' ? 'fragen (Fehler)' : '…'}</span
                  >
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </section>
    {/if}

    {#if pauses.length > 0}
      <section aria-labelledby="pauses-title">
        <h3 id="pauses-title" class="section-title">Aktive Zeitfreigaben und Sperren</h3>
        <ul class="list" aria-label="Aktive Zeitfreigaben und Sperren">
          {#each pauses as p (p.id)}
            <li class="item pause" data-pause={p.id}>
              <div class="item-head">
                <span class="pause-what">
                  {#if scopeText(p)}{scopeText(p)}{:else}<span class="tool-name">{p.toolName}</span>{/if}
                </span>
                <span class="chip pause-{p.effect.toLowerCase()}">{p.effect === 'ALLOW' ? 'Erlaubt' : 'Gesperrt'}</span>
              </div>
              <p class="hint pause-meta">{p.clientName} · {untilText(p.until)}</p>
              {#if p.purpose}<p class="pause-purpose" data-testid="pause-purpose">Wofür: {p.purpose}{#if p.purposeSource === 'suggested'}{' '}<span data-testid="pause-purpose-suggested">(Vorschlag)</span>{/if}</p>{/if}
              <button type="button" class="btn" disabled={busy} onclick={() => lift(p)} aria-label={`${p.effect === 'ALLOW' ? 'Zeitfreigabe beenden' : 'Sperre aufheben'}: ${p.toolName ?? scopeText(p)}, ${p.clientName}`}>
                Aufheben
              </button>
            </li>
          {/each}
        </ul>
        <p class="hint section-hint">„Erlaubt“: ohne Nachfrage erlaubt. „Gesperrt“: wird abgelehnt, ohne zu fragen.</p>
      </section>
    {/if}

    <section aria-labelledby="tools-title">
      <div class="section-head">
        <h3 id="tools-title" class="section-title">Tools</h3>
        <button type="button" class="btn" disabled={refreshing || busy} onclick={refresh}>
          {refreshing ? 'Lädt…' : 'Tools aktualisieren'}
        </button>
      </div>

      {#if unremarkableCount > 0}
        <button type="button" class="btn wide bulk-ack" disabled={busy} onclick={acknowledgeUnremarkable}>
          Alle unauffälligen bestätigen ({unremarkableCount})
        </button>
        <p class="hint section-hint">Bestätigt nur neue oder geänderte Tools ohne Auffälligkeit. „Genauer ansehen“ bestätigst du einzeln.</p>
      {/if}

      {#if view.tools.length === 0}
        <p class="empty">Noch keine Tools bekannt. „Tools aktualisieren“ holt sie vom Upstream.</p>
      {:else}
        <ul class="list" aria-label="Tools">
          {#each sortedTools as t (t.id)}
            <li class="item tool" class:attention={t.review.attention} data-tool={t.name}>
              <div class="item-head">
                <span class="tool-name">{t.name}</span>
                {#if t.isNew}<span class="badge new">Neu</span>{/if}
                {#if t.isChanged}<span class="badge changed">Geändert</span>{/if}
              </div>
              <div class="chips">
                <span class="chip hint-{t.hint}">{HINT_LABEL[t.hint]}</span>
              </div>
              {#if t.description}<p class="tool-desc">{t.description}</p>{/if}
              <ToolReview tool={t} />

              {#if selected && t.forClient}
                {@const f = t.forClient}
                <p class="for-client" class:hidden-row={f.path === 'client-hidden'} data-testid="for-client">
                  <strong>{forClientText(f)}</strong>
                </p>
                <label class="client-row" class:masked={f.masked}>
                  <span class="client-name">Regel für {selected.name}{#if f.masked}<span class="masked-note" data-testid="masked">wirkungslos: Upstream für {selected.name} verborgen</span>{/if}</span>
                  <select
                    aria-label={`Regel für ${t.name} bei ${selected.name}`}
                    value={clientPolicy(t, selected.id)}
                    disabled={busy}
                    onchange={(e) => setClient(t, selected.id, e.currentTarget.value)}
                  >
                    <option value="">Wie für alle ({POLICY_LABEL[t.effectivePolicy]})</option>
                    {#each POLICIES as p}<option value={p}>{POLICY_LABEL[p]}</option>{/each}
                  </select>
                </label>
              {:else}
              <div class="segmented five" role="radiogroup" aria-label={`Regel für ${t.name}`}>
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
              {#if t.policy === 'AUTO' || (t.policy === null && t.effectivePolicy === 'AUTO')}
                <p class="hint auto-tool-note">nutzt die Auto-Regel des Upstreams</p>
              {/if}
              {/if}

              {#if t.isChanged}
                <p class="hint changed-note">Beschreibung, Hinweise oder Parameter dieses Tools haben sich geändert. Bis du es ansiehst, wird jeder Aufruf erfragt, auch wenn eine eigene Regel „Erlauben“ sagt („Fragen“ und „Verbieten“ gelten weiter).</p>
              {/if}
              {#if t.isNew || t.isChanged}
                <button type="button" class="btn wide" disabled={busy} onclick={() => acknowledge(t)}>Gesehen, Standard anwenden</button>
              {/if}

              {#if view.clients.length > 0 && !selected}
                <details class="client-overrides">
                  <summary>
                    Pro Client{t.clientPolicies.length > 0 ? ` (${t.clientPolicies.length} abweichend)` : ''}
                  </summary>
                  {#each view.clients as c (c.id)}
                    <label class="client-row" class:masked={clientMasked(t, c.id)}>
                      <span class="client-name"
                        >{c.name}{#if c.paused}
                          <span class="chip paused" data-testid="client-paused">pausiert</span>{/if}{#if clientMasked(t, c.id)}<span
                            class="masked-note"
                            data-testid="masked">wirkungslos: Upstream für {c.name} verborgen</span
                          >{/if}</span
                      >
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

<style>
  /* ADR-0032 "Gilt für": wrapping pills, each a full touch target. */
  .scope-switch {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .scope-switch label {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: var(--tap);
    max-width: 100%;
    padding: 0 0.875rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    cursor: pointer;
    font-size: 0.9375rem;
  }
  .scope-switch label.selected {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .scope-switch label.selected .chip {
    color: #fff;
    border-color: #fff;
    background: transparent;
  }
  .scope-switch input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .scope-switch label:has(input:focus-visible) {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
  .scope-name {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .chip.hidden-chip {
    margin-left: 0.25rem;
  }
  .precedence {
    font-size: 0.8125rem;
  }
  .hidden-note {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius);
    background: var(--warn-soft);
    color: var(--warn);
    font-weight: 600;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .for-client {
    margin: 0;
    font-size: 0.9375rem;
  }
  .for-client.hidden-row {
    color: var(--muted);
  }
  .client-row.masked .client-name {
    color: var(--muted);
  }
  .client-row.masked select {
    opacity: 0.6;
  }
  .masked-note {
    display: block;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .pause {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .pause-what {
    font-weight: 600;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .pause-meta {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .pause-purpose {
    margin: 0;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .pause .btn {
    align-self: flex-start;
  }
  .chip.pause-allow {
    color: var(--ok);
    border-color: var(--ok);
  }
  /* Same as Settings' "pausiert" chip. */
  .chip.paused {
    color: var(--warn);
    border-color: var(--warn);
    background: var(--warn-soft);
    font-weight: 600;
    margin-left: 0.375rem;
  }
  .tool.attention {
    border-color: var(--warn);
    box-shadow: inset 4px 0 0 var(--warn);
  }
  .bulk-ack {
    margin-bottom: 0.25rem;
  }
  .auto-rule {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .auto-note,
  .auto-count {
    margin: 0;
  }
  .auto-label {
    font-weight: 600;
    font-size: 0.875rem;
  }
  .auto-rule textarea {
    width: 100%;
    min-width: 0;
    font: inherit;
    font-size: 1rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--fg);
    resize: vertical;
  }
  .auto-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .auto-test-list {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .auto-test-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .auto-test-time {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .chip.auto-pass {
    color: var(--ok);
    border-color: var(--ok);
  }
  .chip.auto-below,
  .chip.auto-error {
    color: var(--warn);
    border-color: var(--warn);
  }
  .auto-tool-note {
    margin: 0;
  }
  .chip.pause-deny {
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
