// Live updates of the user's held calls (GET /api/approvals/stream, SSE). The
// server only ever sends the caller's own events. EventSource reconnects by
// itself; every (re)connect starts with a full `snapshot`, followed by the
// full `upstreams` fault list (ADR-0022), which is also resent on every change.
import type { PendingApproval, UpstreamFault } from './api';

export interface StreamHandlers {
  snapshot?: (list: PendingApproval[]) => void;
  pending?: (call: PendingApproval) => void;
  resolved?: (ev: { id: string; kind: string }) => void;
  upstreams?: (faults: UpstreamFault[]) => void;
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
  es.addEventListener('upstreams', (e) => {
    const list = parse(e as MessageEvent);
    if (Array.isArray(list)) h.upstreams?.(list);
  });
  es.onopen = () => h.connected?.(true);
  es.onerror = () => h.connected?.(false);
  return () => es.close();
}
