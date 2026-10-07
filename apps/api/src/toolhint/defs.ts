// Tool definitions as xitl stores and compares them (ADR-0031). Pure.
//
// - `canonical`: JSON with sorted object keys (key order is never a change).
// - `schemaText`: the inputSchema as stored on KnownTool. Always a string
//   ("null" when the upstream sent none), so a NULL column only ever means
//   "recorded before ADR-0031" (first sight is stored silently). Over
//   MAX_TOOL_SCHEMA_CHARS: a prefix plus the sha256 of the whole, so any
//   change, also past the cap, still compares different.
// - `isCosmetic`: two descriptions differ only in whitespace, punctuation
//   (Unicode P*) or letter case. Digits, symbols (S*: `<`, `=`, `$` …) and
//   every letter count. The ONLY thing xitl acknowledges by itself.
// - `paramList`: top-level parameters of an object schema, for the hint and
//   the Regeln diff; null when the schema isn't a plain object schema.
import crypto from 'node:crypto';
import { MAX_TOOL_SCHEMA_CHARS } from '../lib/limits.js';

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const TRUNCATED_MARK = '…#sha256:';

export function schemaText(schema: unknown, max: number = MAX_TOOL_SCHEMA_CHARS): string {
  let text: string;
  try {
    text = canonical(schema === undefined ? null : schema);
  } catch {
    // Cyclic or otherwise unserialisable (cannot come from JSON, but fail
    // closed): a fixed marker that differs from any real schema.
    text = '"(nicht darstellbar)"';
  }
  if (text.length <= max) return text;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  return `${text.slice(0, max)}${TRUNCATED_MARK}${hash}`;
}

/** The stored schema parsed back; undefined when absent, truncated or broken. */
export function parseStoredSchema(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw.includes(TRUNCATED_MARK)) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Lower case, punctuation as a space, whitespace runs collapsed, trimmed. */
export function normalizeDescription(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\p{P}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Different texts whose only differences are whitespace, punctuation, case. */
export function isCosmetic(before: string | null | undefined, after: string | null | undefined): boolean {
  if ((before ?? null) === (after ?? null)) return false; // not a change at all
  return normalizeDescription(before) === normalizeDescription(after);
}

export interface Param {
  name: string;
  /** canonical JSON of the `type` field, or null when missing. */
  type: string | null;
  required: boolean;
  description: string | null;
}

/** Top-level parameters of `{type:'object', properties, required}`; null for
 * anything else (no properties object). */
export function paramList(schema: unknown): Param[] | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  const props = s.properties;
  if (props === undefined) return [];
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
  return Object.keys(props as Record<string, unknown>)
    .sort()
    .map((name) => {
      const p = (props as Record<string, unknown>)[name];
      const po = p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
      return {
        name,
        type: po.type === undefined ? null : canonical(po.type),
        required: required.has(name),
        description: typeof po.description === 'string' ? po.description : null,
      };
    });
}

/** The version a Clef label belongs to: hash of the stored definition. */
export function versionKey(t: { name: string; description: string | null; annotations: string | null; inputSchema: string | null }): string {
  return crypto
    .createHash('sha256')
    .update(canonical([t.name, t.description, t.annotations === null ? null : canonical(parseJson(t.annotations)), t.inputSchema]))
    .digest('hex')
    .slice(0, 32);
}
