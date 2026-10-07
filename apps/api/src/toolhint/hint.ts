// The review hint of a new or changed tool (ADR-0031 §2, §3). Pure,
// unit-tested (TC-151). ADVISORY ONLY: nothing reads it on the call path,
// it never acknowledges a tool and never changes a policy (§5). The
// deterministic reasons come first and don't depend on any model; the Clef
// label (stored on KnownTool) can only ADD reasons, never remove one.
//
// Attention ("Genauer ansehen") reasons, comparing the current definition
// with the acknowledged one (prev*):
//   readOnlyHint true -> false or missing
//   destructiveHint newly true          (a NEW tool: true at all)
//   openWorldHint newly true            (a NEW tool: true at all)
//   a new parameter (required or not; required named as such)
//   a parameter removed, or its type changed
//   description grown by > 50 % or > 400 characters
//   the upstream URL changed (ADR-0021)
//   the schema changed in a way the parameter view can't show (not a plain
//     object schema, or over the size cap): fail closed
//   Clef: risiko higher than the annotations claim; p(injection) ≥ 0.5
// A brand-new tool has no previous version: only its own annotations
// (destructive / open world) and the Clef label can make it remarkable.
import { HINT_GROWTH_CHARS, HINT_GROWTH_RATIO, HINT_INJECTION_THRESHOLD } from '../lib/limits.js';
import { paramList, parseJson, parseStoredSchema, type Param } from './defs.js';

export const RISKS = ['lesen', 'aendern', 'zerstoeren'] as const;
export type HintRisk = (typeof RISKS)[number];

export const RISK_WORD: Record<HintRisk, string> = { lesen: 'lesend', aendern: 'ändernd', zerstoeren: 'zerstörend' };

export interface HintTool {
  isNew: boolean;
  isChanged: boolean;
  /** changedAt came from an upstream URL change (ADR-0021). */
  urlChanged: boolean;
  description: string | null;
  /** Parsed annotations (or null). */
  annotations: unknown;
  /** Parsed inputSchema; undefined = not stored / truncated. */
  inputSchema: unknown;
  /** The stored schema text differs from the acknowledged one. */
  schemaChanged: boolean;
  /** The acknowledged version (null when none is stored). */
  prevDescription: string | null;
  prevAnnotations: unknown;
  prevInputSchema: unknown;
  /** True when prev* were recorded (a definition change happened). */
  hasPrev: boolean;
  /** Clef label, if any. */
  hintRisk: string | null;
  hintInjection: number | null;
}

export interface ReviewHint {
  /** New or changed, i.e. the user still has to look at it. */
  review: boolean;
  attention: boolean;
  reasons: string[];
  /** "KI: wirkt ändernd" when Clef labelled it. */
  label: string | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** What the annotations claim, on the risk scale. */
export function claimedRisk(annotations: unknown): HintRisk {
  const a = obj(annotations);
  if (a.readOnlyHint === true) return 'lesen';
  if (a.destructiveHint === true) return 'zerstoeren';
  return 'aendern';
}

const isRisk = (v: unknown): v is HintRisk => typeof v === 'string' && (RISKS as readonly string[]).includes(v);

function paramReasons(before: Param[] | null, after: Param[] | null): string[] {
  if (before === null || after === null) return ['Parameter geändert (nicht im Einzelnen darstellbar)'];
  const out: string[] = [];
  const old = new Map(before.map((p) => [p.name, p]));
  const now = new Map(after.map((p) => [p.name, p]));
  for (const p of after) {
    const o = old.get(p.name);
    if (!o) out.push(p.required ? `Neuer Pflichtparameter „${p.name}“` : `Neuer Parameter „${p.name}“`);
    else {
      if (o.type !== p.type) out.push(`Typ von „${p.name}“ geändert`);
      if (p.required && !o.required) out.push(`„${p.name}“ ist jetzt Pflicht`);
    }
  }
  for (const o of before) if (!now.has(o.name)) out.push(`Parameter „${o.name}“ entfernt`);
  return out;
}

export function reviewHint(t: HintTool): ReviewHint {
  const review = t.isNew || t.isChanged;
  const reasons: string[] = [];
  const a = obj(t.annotations);
  const p = obj(t.prevAnnotations);
  const comparable = t.hasPrev && !t.isNew;

  if (comparable) {
    if (p.readOnlyHint === true && a.readOnlyHint !== true) reasons.push('Nicht mehr „nur lesend“');
    if (a.destructiveHint === true && p.destructiveHint !== true) reasons.push('Jetzt als zerstörend markiert');
    if (a.openWorldHint === true && p.openWorldHint !== true) reasons.push('Wirkt jetzt nach außen (openWorld)');
    if (t.schemaChanged) {
      const before = t.prevInputSchema === undefined ? null : paramList(t.prevInputSchema);
      const after = t.inputSchema === undefined ? null : paramList(t.inputSchema);
      reasons.push(...paramReasons(before, after));
    }
    const was = (t.prevDescription ?? '').length;
    const is = (t.description ?? '').length;
    if (is > was * HINT_GROWTH_RATIO || is - was > HINT_GROWTH_CHARS) reasons.push('Beschreibung stark gewachsen');
  } else if (t.isNew) {
    if (a.destructiveHint === true) reasons.push('Als zerstörend markiert');
    if (a.openWorldHint === true) reasons.push('Wirkt nach außen (openWorld)');
  }
  if (t.urlChanged) reasons.push('Neue Adresse des Upstreams');
  // Changed, but the acknowledged version isn't stored (changed before
  // ADR-0031): nothing to compare, so it can't be called unremarkable.
  else if (t.isChanged && !t.hasPrev) reasons.push('Vorherige Fassung nicht gespeichert');

  let label: string | null = null;
  if (isRisk(t.hintRisk)) {
    label = `KI: wirkt ${RISK_WORD[t.hintRisk]}`;
    const claimed = claimedRisk(t.annotations);
    if (RISKS.indexOf(t.hintRisk) > RISKS.indexOf(claimed)) reasons.push(`KI: wirkt ${RISK_WORD[t.hintRisk]}, Tool sagt ${RISK_WORD[claimed]}`);
  }
  if (typeof t.hintInjection === 'number' && Number.isFinite(t.hintInjection) && t.hintInjection >= HINT_INJECTION_THRESHOLD) {
    reasons.push('Beschreibung enthält Anweisungen an KI-Agenten');
  }
  return { review, attention: review && reasons.length > 0, reasons: review ? reasons : [], label: review ? label : null };
}

/** The KnownTool columns the hint reads. */
export interface HintRow {
  description: string | null;
  annotations: string | null;
  inputSchema: string | null;
  acknowledgedAt: Date | null;
  changedAt: Date | null;
  urlChanged: boolean;
  prevDescription: string | null;
  prevAnnotations: string | null;
  prevInputSchema: string | null;
  hintRisk: string | null;
  hintInjection: number | null;
}

/** reviewHint of a stored row. */
export function hintOfRow(r: HintRow): ReviewHint {
  const hasPrev = r.prevDescription !== null || r.prevAnnotations !== null || r.prevInputSchema !== null;
  return reviewHint({
    isNew: r.acknowledgedAt === null && r.changedAt === null,
    isChanged: r.changedAt !== null,
    urlChanged: r.urlChanged === true,
    description: r.description,
    annotations: parseJson(r.annotations),
    inputSchema: parseStoredSchema(r.inputSchema),
    schemaChanged: r.prevInputSchema !== null && r.inputSchema !== null && r.prevInputSchema !== r.inputSchema,
    prevDescription: r.prevDescription,
    prevAnnotations: parseJson(r.prevAnnotations),
    prevInputSchema: parseStoredSchema(r.prevInputSchema),
    hasPrev,
    hintRisk: r.hintRisk,
    hintInjection: r.hintInjection,
  });
}
