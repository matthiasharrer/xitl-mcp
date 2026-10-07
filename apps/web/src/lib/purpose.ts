// "Wofür?" with AI purpose suggestions (TC-172…177). Pure, unit tested
// (purpose.test.ts). A suggestion becomes a purpose only by a human tap AND
// a Zeitfreigabe button; it is never a Sperre's purpose (Matthias: only
// Zeitfreigaben). The server enforces the same (deny + suggested -> 400).

export type PurposeSource = 'typed' | 'suggested';

/** What a decision sends for the "Wofür?" field. `suggested` is the text of
 * the chip last tapped (null: none tapped). The field counts as suggested
 * only while it still holds exactly that text; any edit makes it typed. */
export function purposeFields(
  kind: 'allow' | 'deny',
  text: string,
  suggested: string | null,
): { purpose?: string; purposeSource?: PurposeSource } {
  const t = text.trim();
  if (!t) return {};
  const fromChip = suggested !== null && t === suggested.trim();
  // A Sperre never takes an untouched suggestion: set without purpose.
  if (kind === 'deny') return fromChip ? {} : { purpose: t };
  return fromChip ? { purpose: t, purposeSource: 'suggested' } : { purpose: t };
}

/** The chips to show: label + text, empty/null ones left out. */
export function purposeChips(narrow: string | null | undefined, kind: string | null | undefined): { key: 'narrow' | 'kind'; label: string; text: string }[] {
  const out: { key: 'narrow' | 'kind'; label: string; text: string }[] = [];
  if (typeof narrow === 'string' && narrow.trim()) out.push({ key: 'narrow', label: 'Nur dies', text: narrow.trim() });
  if (typeof kind === 'string' && kind.trim()) out.push({ key: 'kind', label: 'Diese Art', text: kind.trim() });
  return out;
}
