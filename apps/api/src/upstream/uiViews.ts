// MCP Apps views (ADR-0038 + amendment 2026-10-25): the pure part. What a
// tool's view reference is, when a view is shown to a client, what a page
// read must look like to be served, its hash, its CSP for display, and the
// `/mcp` URI rewrite. No DB, no network (upstream/uiPages.ts does those).
//
// - A tool points at its view with `_meta.ui.resourceUri` (deprecated flat
//   `_meta["ui/resourceUri"]` when `ui.resourceUri` is absent); only a
//   `ui://` string of at most MAX_UI_URI_CHARS counts, anything else is no
//   view. `_meta.ui.visibility` without "model" makes a view-only tool; a
//   malformed visibility counts as view-only (fail closed).
// - KnownTool.uiMeta: canonical JSON of the keys the upstream sent
//   (`{resourceUri, visibility}`), "null" without any; part of the tool
//   definition for change detection (tools.ts syncKnownTools).
// - Shown (for one client) = the tool has a view, its switch is on, the page
//   was read (contentHash) and that exact hash is acknowledged, the tool is
//   not DENY for the client and not vanished. View-only tools count only
//   while at least one model-visible tool of the upstream is shown (the
//   "anchor"): without a view nothing legitimate calls them.
// - A page is served only if every content item has the requested URI, the
//   exact mimeType `text/html;profile=mcp-app`, a string `text` or `blob`,
//   and all of it fits MAX_UI_PAGE_BYTES. The hash covers each item's
//   {text|blob, mimeType, meta}, so a widened CSP is a change like new HTML.
import crypto from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import { canonical } from '../toolhint/defs.js';
import { isUpstreamSlug } from '../lib/slugs.js';
import { MAX_UI_CSP_ENTRIES, MAX_UI_CSP_ENTRY_CHARS, MAX_UI_META_CHARS, MAX_UI_PAGE_BYTES, MAX_UI_URI_CHARS } from '../lib/limits.js';

export const UI_MIME = 'text/html;profile=mcp-app';
const UI_SCHEME = 'ui://';
const TRUNCATED = '…#sha256:';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A usable view URI: `ui://` plus at least one non-space character, no
 * whitespace or control characters, at most MAX_UI_URI_CHARS. */
export function isUiUri(v: unknown): v is string {
  return typeof v === 'string' && v.length > UI_SCHEME.length && v.length <= MAX_UI_URI_CHARS && v.startsWith(UI_SCHEME) && !/[\s\p{Cc}]/u.test(v);
}

/** The raw view reference of a tool: `ui.resourceUri` (any value) wins over
 * the flat key; `undefined` when neither is present. */
function rawResourceUri(meta: unknown): unknown {
  if (!isRecord(meta)) return undefined;
  if (isRecord(meta.ui) && 'resourceUri' in meta.ui) return meta.ui.resourceUri;
  return 'ui/resourceUri' in meta ? meta['ui/resourceUri'] : undefined;
}

/** KnownTool.uiMeta for a tool (see the header). Over MAX_UI_META_CHARS: a
 * prefix plus the sha256 of the whole, so a change past the cap differs. */
export function uiMetaText(t: Tool): string {
  const meta = (t as { _meta?: unknown })._meta;
  const out: Record<string, unknown> = {};
  const uri = rawResourceUri(meta);
  if (uri !== undefined) out.resourceUri = uri;
  if (isRecord(meta) && isRecord(meta.ui) && 'visibility' in meta.ui) out.visibility = meta.ui.visibility;
  if (Object.keys(out).length === 0) return 'null';
  let text: string;
  try {
    text = canonical(out);
  } catch {
    text = '"(nicht darstellbar)"';
  }
  if (text.length <= MAX_UI_META_CHARS) return text;
  return `${text.slice(0, MAX_UI_META_CHARS)}${TRUNCATED}${crypto.createHash('sha256').update(text).digest('hex')}`;
}

/** The tool's view URI, or null (no view). */
export function uiResourceUriOf(t: Tool): string | null {
  const uri = rawResourceUri((t as { _meta?: unknown })._meta);
  return isUiUri(uri) ? uri : null;
}

/** View-only by a visibility value that was present: anything but an array
 * of strings containing "model" (fail closed). */
function appOnlyVisibility(v: unknown): boolean {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return true;
  return !v.includes('model');
}

/** ADR-0038: the upstream wants only its view to call this tool. Absent
 * visibility = both (spec default); malformed = view-only. */
export function isAppOnly(t: Tool): boolean {
  const meta = (t as { _meta?: unknown })._meta;
  if (!isRecord(meta) || !isRecord(meta.ui) || !('visibility' in meta.ui)) return false;
  return appOnlyVisibility(meta.ui.visibility);
}

/** isAppOnly from a stored uiMeta. NULL / "null": not view-only; a clipped
 * or unreadable value: view-only (fail closed). */
export function appOnlyFromUiMeta(text: string | null | undefined): boolean {
  if (text === null || text === undefined || text === 'null') return false;
  if (text.includes(TRUNCATED)) return true;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return true;
  }
  if (!isRecord(v)) return true;
  return 'visibility' in v ? appOnlyVisibility(v.visibility) : false;
}

// ---- Pages ------------------------------------------------------------------

export interface PageItem {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

/** The content items of a resources/read answer if it is a servable page of
 * `uri` (see the header), normalised to exactly the fields xitl serves and
 * hashes; null otherwise. */
export function validatePage(result: unknown, uri: string, maxBytes: number = MAX_UI_PAGE_BYTES): PageItem[] | null {
  if (!isRecord(result) || !Array.isArray(result.contents) || result.contents.length === 0) return null;
  const items: PageItem[] = [];
  for (const c of result.contents as unknown[]) {
    if (!isRecord(c) || c.uri !== uri || c.mimeType !== UI_MIME) return null;
    const hasText = 'text' in c && c.text !== undefined;
    const hasBlob = 'blob' in c && c.blob !== undefined;
    if (hasText === hasBlob) return null;
    if (hasText && typeof c.text !== 'string') return null;
    if (hasBlob && typeof c.blob !== 'string') return null;
    if ('_meta' in c && c._meta !== undefined && !isRecord(c._meta)) return null;
    items.push({
      uri,
      mimeType: UI_MIME,
      ...(hasText ? { text: c.text as string } : { blob: c.blob as string }),
      ...(isRecord(c._meta) ? { _meta: c._meta } : {}),
    });
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(items), 'utf8');
  } catch {
    return null;
  }
  return size <= maxBytes ? items : null;
}

/** sha256 (hex) of canonical JSON of the items' {text|blob, mimeType, meta}. */
export function pageHash(items: PageItem[]): string {
  const material = items.map((i) => ({ ...(i.text !== undefined ? { text: i.text } : { blob: i.blob }), mimeType: i.mimeType, meta: i._meta ?? null }));
  return crypto.createHash('sha256').update(canonical(material)).digest('hex');
}

export interface PageCsp {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
  permissions: string[];
}
const CSP_LISTS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;

const clipList = (xs: Iterable<string>) => [...new Set(xs)].slice(0, MAX_UI_CSP_ENTRIES).map((s) => s.slice(0, MAX_UI_CSP_ENTRY_CHARS));

/** What the page's `_meta.ui` (csp, permissions) asks for, merged over the
 * items and clipped, for display on the tool card. null when no item says
 * anything (the host's default: no external connections). */
export function pageCsp(items: PageItem[]): PageCsp | null {
  const lists: Record<string, string[]> = Object.fromEntries(CSP_LISTS.map((k) => [k, []]));
  const permissions: string[] = [];
  let any = false;
  for (const i of items) {
    const ui = isRecord(i._meta) && isRecord(i._meta.ui) ? i._meta.ui : null;
    if (!ui) continue;
    if (isRecord(ui.csp)) {
      for (const k of CSP_LISTS) {
        const v = ui.csp[k];
        if (!Array.isArray(v)) continue;
        any = true;
        lists[k]!.push(...v.filter((x): x is string => typeof x === 'string'));
      }
    }
    const p = ui.permissions;
    if (isRecord(p)) {
      any = true;
      permissions.push(...Object.keys(p));
    } else if (Array.isArray(p)) {
      any = true;
      permissions.push(...p.filter((x): x is string => typeof x === 'string'));
    }
  }
  if (!any) return null;
  return {
    connectDomains: clipList(lists.connectDomains!),
    resourceDomains: clipList(lists.resourceDomains!),
    frameDomains: clipList(lists.frameDomains!),
    baseUriDomains: clipList(lists.baseUriDomains!),
    permissions: clipList(permissions),
  };
}

/** UiResource.csp parsed back for the API; null when absent or unreadable. */
export function parseCsp(text: string | null | undefined): PageCsp | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (!isRecord(v)) return null;
    const list = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    return {
      connectDomains: list('connectDomains'),
      resourceDomains: list('resourceDomains'),
      frameDomains: list('frameDomains'),
      baseUriDomains: list('baseUriDomains'),
      permissions: list('permissions'),
    };
  } catch {
    return null;
  }
}

// ---- Shown ------------------------------------------------------------------

export interface PageState {
  contentHash: string | null;
  acknowledgedHash: string | null;
  lastReadFailed?: boolean;
}

export interface ViewRow {
  name: string;
  uiResourceUri: string | null;
  uiEnabled: boolean;
  appOnly: boolean;
  /** The tool's policy for this client is DENY (not listed). */
  denied: boolean;
  /** The upstream's latest list did not contain it (ADR-0034). */
  vanished: boolean;
}

/** One tool's view is shown to a client (before the anchor rule). */
export function viewShown(row: ViewRow, page: PageState | null | undefined): boolean {
  return (
    row.uiResourceUri !== null &&
    row.uiEnabled === true &&
    !row.denied &&
    !row.vanished &&
    !!page &&
    typeof page.contentHash === 'string' &&
    page.contentHash.length > 0 &&
    page.contentHash === page.acknowledgedHash
  );
}

export interface ShownViews {
  /** Names of the tools whose view is shown (listed with `_meta.ui`). */
  shown: Set<string>;
  /** At least one model-visible tool's view is shown: view-only tools are
   * listed and callable. */
  anchor: boolean;
  /** The upstream URIs of the shown pages (what resources/read may serve),
   * each with the names of the shown tools using it. */
  uris: Map<string, string[]>;
}

/** Which views of one upstream are shown to one client (rows of that
 * upstream; pages by their upstream URI). */
export function shownViews(rows: ViewRow[], pages: ReadonlyMap<string, PageState>): ShownViews {
  const candidates = rows.filter((r) => viewShown(r, r.uiResourceUri === null ? null : pages.get(r.uiResourceUri)));
  const anchor = candidates.some((r) => !r.appOnly);
  const shown = anchor ? candidates : [];
  const uris = new Map<string, string[]>();
  for (const r of shown) uris.set(r.uiResourceUri!, [...(uris.get(r.uiResourceUri!) ?? []), r.name]);
  return { shown: new Set(shown.map((r) => r.name)), anchor, uris };
}

export type UiState = 'new' | 'shown' | 'off' | 'changed' | 'unreadable';

/** What the Regeln page says about a tool's view (independent of clients):
 * never read: "new" ("unreadable" when the read failed); read, never
 * acknowledged: "new"; acknowledged hash differs: "changed" (on every tool
 * using the page); else the tool's switch. */
export function uiState(uiEnabled: boolean, page: PageState | null | undefined): UiState {
  if (!page || !page.contentHash) return page?.lastReadFailed ? 'unreadable' : 'new';
  if (!page.acknowledgedHash) return 'new';
  if (page.contentHash !== page.acknowledgedHash) return 'changed';
  return uiEnabled ? 'shown' : 'off';
}

// ---- `/mcp` URIs --------------------------------------------------------------

/** `ui://<slug>/<original without ui://>` (ADR-0038 item 3). */
export function unifiedUiUri(slug: string, uri: string): string {
  return `${UI_SCHEME}${slug}/${uri.slice(UI_SCHEME.length)}`;
}

/** The reverse of unifiedUiUri; null for anything it could not have made. */
export function splitUnifiedUiUri(uri: unknown): { slug: string; uri: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith(UI_SCHEME) || uri.length > MAX_UI_URI_CHARS + 64) return null;
  const rest = uri.slice(UI_SCHEME.length);
  const at = rest.indexOf('/');
  if (at <= 0) return null;
  const slug = rest.slice(0, at);
  const original = `${UI_SCHEME}${rest.slice(at + 1)}`;
  if (!isUpstreamSlug(slug) || !isUiUri(original)) return null;
  return { slug, uri: original };
}

/** A shown tool as listed on `/mcp`: `ui.resourceUri` and the flat key
 * rewritten to the unified form (a flat value that is no view URI is
 * dropped); nothing else in `_meta` changes. */
export function withUnifiedUiUri(t: Tool, slug: string): Tool {
  const meta = (t as { _meta?: unknown })._meta;
  if (!isRecord(meta)) return t;
  const out: Record<string, unknown> = { ...meta };
  if (isRecord(meta.ui) && isUiUri(meta.ui.resourceUri)) out.ui = { ...meta.ui, resourceUri: unifiedUiUri(slug, meta.ui.resourceUri) };
  if ('ui/resourceUri' in meta) {
    const flat = meta['ui/resourceUri'];
    if (isUiUri(flat)) out['ui/resourceUri'] = unifiedUiUri(slug, flat);
    else delete out['ui/resourceUri'];
  }
  return { ...t, _meta: out } as Tool;
}
