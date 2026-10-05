// Browser origins per access token (ADR-0023): the normalizer/validator for
// `McpClient.allowedOrigins`, and the exact membership test the CORS gate in
// mcp/mount.ts uses. Pure; unit tested in origins.test.ts.
//
// An origin is `http(s)://host[:port]`, normalized by `new URL().origin`
// (lowercase host, default port dropped, IDN to punycode). Input may carry
// exactly one trailing `/` and nothing else after host[:port]: no path, query,
// fragment, userinfo, wildcard, `null` or other scheme.

export const MAX_ALLOWED_ORIGINS = 10;
/** No real origin is longer; bounds what we parse and store. */
const MAX_ORIGIN_INPUT = 300;

/** The normalized origin of `input`, or null when it is not an acceptable origin. */
export function normalizeOrigin(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw === '' || raw.length > MAX_ORIGIN_INPUT) return null;
  // Only `scheme://authority` with an optional single trailing slash. The
  // authority must not contain `/ ? # @ \ *` or whitespace: that rules out
  // path, query, fragment, userinfo and wildcards before the URL parser gets
  // a chance to be lenient about them.
  const m = /^(https?):\/\/([^/?#@\\*\s]+)\/?$/i.exec(raw);
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  if (url.hostname === '') return null;
  const origin = url.origin;
  return origin === 'null' ? null : origin;
}

export type ParsedOrigins = { ok: true; origins: string[] } | { ok: false; error: string };

/** Validates a list from the API: every entry an origin, at most 10 after
 * collapsing duplicates (order kept). German error messages. */
export function parseAllowedOrigins(list: unknown): ParsedOrigins {
  if (!Array.isArray(list)) return { ok: false, error: 'Die Web-Adressen müssen eine Liste sein.' };
  const out: string[] = [];
  for (const entry of list) {
    const origin = normalizeOrigin(entry);
    if (origin === null) {
      const shown = typeof entry === 'string' ? entry.trim().slice(0, 80) : String(entry).slice(0, 80);
      return {
        ok: false,
        error: `„${shown}“ ist keine gültige Web-Adresse. Erlaubt ist nur http(s)://host[:port], ohne Pfad, Abfrage oder Zugangsdaten.`,
      };
    }
    if (!out.includes(origin)) out.push(origin);
  }
  if (out.length > MAX_ALLOWED_ORIGINS) return { ok: false, error: `Höchstens ${MAX_ALLOWED_ORIGINS} Web-Adressen pro Token.` };
  return { ok: true, origins: out };
}

/** The stored list (JSON) as origins; anything malformed counts as empty (fail closed). */
export function storedOrigins(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

/** Is the request's `Origin` header value listed in the stored JSON? Exact
 * comparison of normalized origins; a missing/`null`/malformed Origin never is. */
export function originListed(requestOrigin: string | null | undefined, json: string | null | undefined): boolean {
  const origin = normalizeOrigin(requestOrigin);
  if (origin === null) return false;
  return storedOrigins(json).includes(origin);
}
