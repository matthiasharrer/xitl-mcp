// The German texts for a call the AUTO check asked (ADR-0030 §3). Pure;
// shared by the push (approval/message.ts). Fixed wording, no agent data.
// The web app has the same labels (apps/web/src/lib/api.ts autoCheckNote).
export interface AutoCheckView {
  result: 'below' | 'error' | 'off' | 'norule';
  /** p(erlaubt) (below only). */
  score: number | null;
}

const score2 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function autoCheckNote(v: AutoCheckView): string {
  switch (v.result) {
    case 'below':
      return `KI: von deiner Auto-Regel nicht eindeutig gedeckt${v.score !== null ? ` (${score2(v.score)})` : ''}`;
    case 'error':
      return 'KI-Prüfung nicht erreichbar – Auto-Regel fragt nach';
    case 'norule':
      return 'Auto: noch keine Auto-Regel für diesen Upstream – wird gefragt';
    default:
      return 'Auto: KI-Prüfung ausgeschaltet – wird gefragt';
  }
}
