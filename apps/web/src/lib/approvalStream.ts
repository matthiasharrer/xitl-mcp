// Live updates of the user's held calls (GET /api/approvals/stream, SSE). The
// server only ever sends the caller's own events. EventSource reconnects by
// itself; every (re)connect starts with a full `snapshot`, followed by the
// full `upstreams` fault list (ADR-0022), which is also resent on every change.
// `history` carries one Verlauf row (created or changed; the same shape as
// GET /api/audit's entries, ADR-0028). Verlauf refetches on every `snapshot`
// (= every (re)connect) so events missed while disconnected are healed.
// `intent` carries a held call's advisory summary once it is there (ADR-0025).
// `running` (no payload) says the user's Zeitfreigaben/Sperren/paused
// accesses / paused upstreams changed ("Läuft gerade", TC-181, ADR-0033).
// `tools` (no payload) says a sync changed one of the user's tool lists
// (ADR-0034, TC-206): an open Regeln page re-reads its view.
import type { AuditRow, IntentFields, PauseCheckOutage, PauseCheckView, PendingApproval, UpstreamFault } from './api';

export interface StreamHandlers {
  snapshot?: (list: PendingApproval[]) => void;
  pending?: (call: PendingApproval) => void;
  resolved?: (ev: { id: string; kind: string }) => void;
  /** A held call's advisory summary changed (ADR-0025). */
  intent?: (ev: { id: string } & IntentFields) => void;
  /** One of the user's audit rows was created or changed (ADR-0028). */
  history?: (row: AuditRow) => void;
  upstreams?: (faults: UpstreamFault[]) => void;
  /** ADR-0029: a held call the AI check sent back (settle path). */
  checked?: (ev: { id: string; pauseCheck: PauseCheckView | null }) => void;
  /** ADR-0029: the user's AI check outage (on connect, then on change). */
  pausecheck?: (state: PauseCheckOutage) => void;
  /** "Läuft gerade" changed (TC-181): re-read /api/running. */
  running?: () => void;
  /** ADR-0034: a sync changed a tool list: re-read the Regeln view. */
  tools?: () => void;
  connected?: (ok: boolean) => void;
}

export function openApprovalStream(h: StreamHandlers): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource('/api/approvals/stream');
  const parse = (e: MessageEvent) => {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  };
  es.addEventListener('snapshot', (e) => {
    const list = parse(e as MessageEvent);
    if (Array.isArray(list)) h.snapshot?.(list);
  });
  es.addEventListener('pending', (e) => {
    const call = parse(e as MessageEvent);
    if (call) h.pending?.(call);
  });
  es.addEventListener('resolved', (e) => {
    const ev = parse(e as MessageEvent);
    if (ev) h.resolved?.(ev);
  });
  es.addEventListener('intent', (e) => {
    const ev = parse(e as MessageEvent);
    if (ev && typeof ev.id === 'string') h.intent?.(ev);
  });
  es.addEventListener('history', (e) => {
    const row = parse(e as MessageEvent);
    if (row && typeof row.id === 'number') h.history?.(row);
  });
  es.addEventListener('upstreams', (e) => {
    const list = parse(e as MessageEvent);
    if (Array.isArray(list)) h.upstreams?.(list);
  });
  es.addEventListener('checked', (e) => {
    const ev = parse(e as MessageEvent);
    if (ev && typeof ev.id === 'string') h.checked?.(ev);
  });
  es.addEventListener('pausecheck', (e) => {
    const ev = parse(e as MessageEvent);
    if (ev && typeof ev.failing === 'boolean') h.pausecheck?.(ev);
  });
  es.addEventListener('running', () => h.running?.());
  es.addEventListener('tools', () => h.tools?.());
  es.onopen = () => h.connected?.(true);
  es.onerror = () => h.connected?.(false);
  return () => es.close();
}
