// Parses the model's answer (ADR-0025). Pure, unit tested (TC-107).
//
// Expected: one JSON object {"title"?: string, "intent": string, "risk":
// read|write|destructive, "concerns"?: string}. A missing or empty title is
// fine (null); the rest is required. Anything else is a failure (no summary shown): the
// answer is model output from attacker-controlled input, so it is only ever
// taken as plain data, length-capped, and rendered as text by the UI.
import { MAX_INTENT_SUMMARY_CHARS, MAX_INTENT_TITLE_CHARS } from '../lib/limits.js';
import { isRisk, type Risk } from './risk.js';

export interface ParsedIntent {
  /** 3-5 words (TC-126), one line, ≤ MAX_INTENT_TITLE_CHARS; null if absent. */
  title: string | null;
  intent: string;
  risk: Risk;
  concerns: string | null;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Collapses whitespace (incl. newlines) so the summary is one paragraph. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Control characters (incl. bidi overrides and zero-width marks) out. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ');

function asObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  // Prose or a ```json fence around it: accepted only if the span from the
  // first "{" to the last "}" is exactly one object. Two objects, or an
  // unbalanced brace, don't parse as one and fail.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return tryParse(text.slice(start, end + 1));
}

/** The parsed answer, or null (FAILED). */
export function parseAnswer(raw: string): ParsedIntent | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const o = asObject(raw);
  if (!o) return null;
  const intent = typeof o.intent === 'string' ? flat(o.intent) : '';
  if (!intent) return null;
  const risk = typeof o.risk === 'string' ? o.risk.trim().toLowerCase() : '';
  if (!isRisk(risk)) return null;
  // concerns: a string or a list of strings; anything else is ignored.
  let concerns: string | null = null;
  if (typeof o.concerns === 'string') concerns = flat(o.concerns) || null;
  else if (Array.isArray(o.concerns)) concerns = flat(o.concerns.filter((c): c is string => typeof c === 'string').join('; ')) || null;
  const title = typeof o.title === 'string' ? flat(clean(o.title)) : '';
  return { title: title ? cut(title, MAX_INTENT_TITLE_CHARS) : null, intent: cut(intent, MAX_INTENT_SUMMARY_CHARS), risk, concerns: concerns ? cut(concerns, MAX_INTENT_SUMMARY_CHARS) : null };
}

/** The text the UI shows: intent, then concerns, capped. */
export function summaryText(p: ParsedIntent): string {
  return cut(p.concerns ? `${p.intent} Auffällig: ${p.concerns}` : p.intent, MAX_INTENT_SUMMARY_CHARS);
}
