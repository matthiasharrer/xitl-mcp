// Audit row events (ADR-0028): a tiny in-process emitter (single replica), like
// upstream/stateEvents.ts. Emitted after every write to an AuditEntry (created,
// outcome set, intent summary arrived). The approval stream listens and sends
// the user's own changed row to Verlauf. The event carries ids only: the
// stream re-reads the row itself, scoped to its user, so nothing but what the
// history API would return can leave.
//
// Emitting never throws into the caller (the contact path): listener errors
// are caught and logged by class only.
export interface AuditChange {
  userId: number;
  auditId: number;
}

type Listener = (ev: AuditChange) => void;

export class AuditEvents {
  private listeners = new Set<Listener>();

  /** Returns the unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(ev: AuditChange): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (e) {
        console.warn(`audit event listener failed: ${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
  }
}

export const auditEvents = new AuditEvents();
