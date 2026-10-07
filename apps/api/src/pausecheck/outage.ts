// The visible outage of the AI check (ADR-0029 §5), in the pattern of the
// upstream faults (ADR-0022): a failed check marks the user's check as
// failing (Freigaben card "KI-Prüfung nicht erreichbar – Zeitfreigaben fragen
// wieder nach", one push per outage with a cooldown); the next successful
// check, or the user turning the check off, clears it. No background probing.
//
// In memory (single replica): a restart forgets the card; the next failed
// check raises it again. Per user: only the affected user sees it.
// Listeners never throw into the caller (the decision path).
import { systemClock, type Clock } from '../lib/clock.js';

export interface OutageEvent {
  userId: number;
  /** ISO time of the first failure of this outage, or null = cleared. */
  since: string | null;
  /** true only on the transition ok -> failing (the push channel's cue). */
  started: boolean;
}

type Listener = (ev: OutageEvent) => void;

export class PauseCheckOutage {
  private failing = new Map<number, Date>();
  private listeners = new Set<Listener>();

  constructor(private clock: Clock = systemClock) {}

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** The user's outage start, or null. */
  since(userId: number): Date | null {
    return this.failing.get(userId) ?? null;
  }

  failed(userId: number): void {
    if (this.failing.has(userId)) return;
    const at = this.clock.now();
    this.failing.set(userId, at);
    this.emit({ userId, since: at.toISOString(), started: true });
  }

  /** A successful check, or the switch turned off. */
  cleared(userId: number): void {
    if (!this.failing.delete(userId)) return;
    this.emit({ userId, since: null, started: false });
  }

  private emit(ev: OutageEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (e) {
        console.warn(`pause check outage listener failed: ${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
  }
}
