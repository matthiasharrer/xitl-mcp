// Tool list events (ADR-0034, TC-206): a tiny in-process emitter (single
// replica), like pauseEvents.ts. Emitted by upstream/tools.ts syncKnownTools
// when a sync changed something the Regeln page shows (a tool added, its
// definition changed, cosmetically or not, or stale rows pruned), whoever
// triggered the sync: a proxied tools/list, "Tools aktualisieren" or the
// call-time re-check. Carries the user id only: the approval stream sends that
// user a payload-free `tools` ping and an open Regeln page re-reads its view,
// scoped to its user.
//
// Emitting never throws into the caller.
export interface ToolsChange {
  userId: number;
}

type Listener = (ev: ToolsChange) => void;

export class ToolEvents {
  private listeners = new Set<Listener>();

  /** Returns the unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(ev: ToolsChange): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (e) {
        console.warn(`tool event listener failed: ${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
  }
}

export const toolEvents = new ToolEvents();
