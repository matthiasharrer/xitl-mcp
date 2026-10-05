// Upstream state events (ADR-0022): a tiny typed in-process emitter (single
// replica). Two kinds:
// - 'transition': the conditional writes found a real change of state
//   (connection.ts: ok -> unreachable and back; oauthClient.ts: -> reconnect,
//   connect callback -> ok). The push channel listens to these.
// - 'edit': the row changed in a way that may change the user's fault list
//   without being a transition (renamed, URL/login changed, deleted). Only the
//   Freigaben stream recomputes on these; nothing is pushed.
//
// Emitting never throws into the caller (the contact path): listener errors
// are caught and logged by class only.
export type UpstreamStateKind = 'ok' | 'unreachable' | 'reconnect';

export interface UpstreamStateEvent {
  userId: number;
  upstreamId: number;
  state: UpstreamStateKind;
  cause: 'transition' | 'edit';
}

type Listener = (ev: UpstreamStateEvent) => void;

export class UpstreamStateEvents {
  private listeners = new Set<Listener>();

  /** Returns the unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(ev: UpstreamStateEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (e) {
        console.warn(`upstream state listener failed: ${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
  }
}

export const upstreamStates = new UpstreamStateEvents();
