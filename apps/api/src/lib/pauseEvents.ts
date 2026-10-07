// "Läuft gerade" events (TC-178…183): a tiny in-process emitter (single
// replica), like auditEvents.ts. Emitted after a user's Zeitfreigaben/Sperren
// (Snooze rows) or paused accesses changed: created, lifted, all ended, ended
// by the AI check (ADR-0029 mismatch), pause/resume of an access, deletions
// that take Snooze rows with them. Carries the user id only: the approval
// stream sends that user a payload-free `running` ping and the page re-reads
// GET /api/running, scoped to its user. Expiry by time is not an event (the
// client drops entries whose `until` passed).
//
// Emitting never throws into the caller.
export interface PauseChange {
  userId: number;
}

type Listener = (ev: PauseChange) => void;

export class PauseEvents {
  private listeners = new Set<Listener>();

  /** Returns the unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(ev: PauseChange): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (e) {
        console.warn(`pause event listener failed: ${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
  }
}

export const pauseEvents = new PauseEvents();
