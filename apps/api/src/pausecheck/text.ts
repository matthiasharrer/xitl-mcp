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

/** ADR-0026 amendment: a call Clef judged outside a Sperre's purpose. The
 * purpose is the human's own text (capped). */
export function sperreCheckNote(purpose: string): string {
  const p = purpose.length > 120 ? `${purpose.slice(0, 119)}…` : purpose;
  return `KI-Prüfung: fällt nicht unter die Sperre („${p}“) – bitte entscheiden`;
}
