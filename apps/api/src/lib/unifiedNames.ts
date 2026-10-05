// Tool names on the unified endpoint `/mcp` (ADR-0014, ADR-0017):
// `<slug>_<upstream tool name>`. Slugs cannot contain `_` (lib/slugs.ts), so
// the FIRST `_` always separates slug from tool name: collision-free, no lookup
// table. Names outside the MCP tool-name rules are neither listed nor callable.
import { isUpstreamSlug } from './slugs.js';

/** MCP tool-name rules (spec 2025-11-25): 1–128 of A–Z a–z 0–9 _ - . */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** The listed name of `tool` from upstream `slug`; null when it would break
 * the MCP name rules (the tool is then not listed on `/mcp`). */
export function unifiedName(slug: string, tool: string): string | null {
  const name = `${slug}_${tool}`;
  return tool.length > 0 && MCP_TOOL_NAME.test(name) ? name : null;
}

/** Splits a called name into slug and upstream tool name; null for anything
 * that `unifiedName` could not have produced. */
export function splitUnifiedName(name: string): { slug: string; tool: string } | null {
  if (typeof name !== 'string' || !MCP_TOOL_NAME.test(name)) return null;
  const at = name.indexOf('_');
  if (at <= 0) return null;
  const slug = name.slice(0, at);
  const tool = name.slice(at + 1);
  if (tool.length === 0 || !isUpstreamSlug(slug)) return null;
  return { slug, tool };
}
