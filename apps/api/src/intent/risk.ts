// Shown risk of an intent summary (ADR-0025 §5). Pure, unit tested (TC-108).
//
// The model's verdict is attacker-influenced (the agent writes the arguments,
// the upstream the descriptions), so it may RAISE the risk shown but never
// lower it below the tool's own hint (`toolHint` from the STORED annotations;
// none = write). When the model rated lower, `lowered` makes the UI warn.
import { toolHint, type ToolHint } from '../lib/proxyText.js';

export type Risk = ToolHint; // 'read' | 'write' | 'destructive'

export const RISKS: readonly Risk[] = ['read', 'write', 'destructive'];

const rank = (r: Risk) => RISKS.indexOf(r);

export function isRisk(v: unknown): v is Risk {
  return typeof v === 'string' && (RISKS as readonly string[]).includes(v);
}

/** The hint of a KnownTool's stored annotations (a JSON string or null).
 * Unparseable / missing = no annotations = write. */
export function hintOfStored(annotations: string | null | undefined): Risk {
  if (!annotations) return 'write';
  try {
    return toolHint(JSON.parse(annotations));
  } catch {
    return 'write';
  }
}

/** max(hint, model) on read < write < destructive; `lowered` when the model
 * said less than the hint. */
export function floorRisk(hint: Risk, model: Risk): { risk: Risk; lowered: boolean } {
  return { risk: rank(model) > rank(hint) ? model : hint, lowered: rank(model) < rank(hint) };
}
