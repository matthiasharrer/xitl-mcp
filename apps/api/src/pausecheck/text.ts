// The German texts for a call the AI check sent back to the human (ADR-0029
// §4, §5). Pure; shared by the push (approval/message.ts). Fixed wording, no
// agent data. The web app has the same labels (apps/web/src/lib/api.ts).
export interface PauseCheckView {
  result: 'mismatch' | 'error';
  /** The deviation that won (mismatch only). */
  choice: 'richtungswechsel' | 'ausweitung' | null;
  /** p(gleich) (mismatch only). */
  score: number | null;
}

export const DEVIATION_LABEL = { richtungswechsel: 'Richtungswechsel', ausweitung: 'Ausweitung' } as const;

export function pauseCheckNote(v: PauseCheckView): string {
  if (v.result === 'mismatch') {
    const label = v.choice ? DEVIATION_LABEL[v.choice] : null;
    return `KI-Prüfung: weicht ab${label ? ` (${label})` : ''} – Zeitfreigabe beendet`;
  }
  return 'KI-Prüfung nicht erreichbar';
}
