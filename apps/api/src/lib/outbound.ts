// Outbound address policy (ADR-0020): every HTTP request xitl makes to a URL it
// did not choose (upstream MCP traffic, OAuth discovery/DCR/token/refresh, Web
// Push) goes through this module, and none of them may reach an internal
// address unless the URL's host is on the admin's exception list
// (OUTBOUND_ALLOW_PRIVATE).
//
// Enforcement is on the address actually connected to:
// - an IP-literal host is classified before anything is sent (no DNS lookup
//   happens for literals, so the lookup hook would never see it),
// - a name is checked inside the connection's own DNS lookup (the undici
//   Agent's `connect.lookup` for fetch, the https.Agent's `lookup` for web
//   push): the addresses judged are the ones the socket then connects to, so
//   a DNS answer that changes between a check and the connect can't slip past.
// If a name resolves to several addresses and ANY is blocked, it is refused.
//
// Nothing else in apps/api/src calls `fetch` directly (outbound.test.ts scans
// for it). Blocked requests are logged with the hostname only: paths and
// queries can carry secrets.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { Agent, type Dispatcher } from 'undici';

/** A request to an internal address was refused (ADR-0020). Carries the
 * hostname only, never the path. */
export class OutboundBlocked extends Error {
  override name = 'OutboundBlocked';
  readonly code = 'OUTBOUND_BLOCKED';
  constructor(readonly hostname: string) {
    super(`outbound request to ${hostname} blocked (internal address)`);
  }
}

function logBlocked(hostname: string): void {
  console.warn(`outbound: blocked request to host ${hostname} (internal address)`);
}

// ---- classifier ----------------------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** [prefix bytes..., prefix length] */
const BLOCKED_V4: [number, number, number, number][] = [
  [0, 0, 0, 8], // 0/8 "this network"
  [10, 0, 0, 8],
  [100, 64, 0, 10], // CGNAT
  [127, 0, 0, 8],
  [169, 254, 0, 16], // link-local, cloud metadata
  [172, 16, 0, 12],
  [192, 0, 0, 24], // IETF protocol assignments
  [192, 168, 0, 16],
  [198, 18, 0, 15], // benchmarking
  [224, 0, 0, 4], // multicast
  [240, 0, 0, 4], // reserved + broadcast
];

function v4Blocked(b: number[]): boolean {
  const addr = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return BLOCKED_V4.some(([p0, p1, p2, len]) => {
    const net = ((p0 << 24) | (p1 << 16) | (p2 << 8)) >>> 0;
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return (addr & mask) >>> 0 === (net & mask) >>> 0;
  });
}

/** Eight 16-bit groups, or null if it isn't a valid IPv6 address. */
function parseIPv6(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (net.isIP(ip) !== 6) return null;
  // Trailing dotted IPv4 (e.g. ::ffff:10.0.0.1) -> two hex groups.
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    ip = `${ip.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function v6Blocked(g: number[]): boolean {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Embedded IPv4: judged by the IPv4 address.
  if (zeros(0, 5) && g[5] === 0xffff) return v4Blocked(v4FromGroups(g[6]!, g[7]!)); // ::ffff:0:0/96 mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4Blocked(v4FromGroups(g[6]!, g[7]!)); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return v4Blocked(v4FromGroups(g[1]!, g[2]!)); // 2002::/16 6to4
  // Deprecated IPv4-compatible ::a.b.c.d (::/96): not in the ADR's list, but
  // judged by its IPv4 address too rather than trusted (fail closed).
  if (zeros(0, 6)) return v4Blocked(v4FromGroups(g[6]!, g[7]!));
  return false;
}

/**
 * Is a connection to this IP address refused by ADR-0020? Accepts IPv4 dotted
 * quads and IPv6 (with or without brackets / zone id). Anything it can't parse
 * counts as blocked (fail closed).
 */
export function isBlockedAddress(address: string): boolean {
  let a = address.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const v4 = net.isIP(a) === 4 ? parseIPv4(a) : null;
  if (v4) return v4Blocked(v4);
  const v6 = parseIPv6(a);
  if (v6) return v6Blocked(v6);
  return true;
}

// ---- exception list (OUTBOUND_ALLOW_PRIVATE) -------------------------------------

export interface AllowEntry {
  /** Lowercase hostname or IP literal as in `URL.hostname` (IPv6 with brackets). */
  host: string;
  port?: number;
}

/** Parses `host`, `host:port`, `[v6]`, `[v6]:port` entries, comma-separated.
 * Malformed entries are returned in `invalid` (and ignored). */
export function parseAllowList(raw: string | undefined): { entries: AllowEntry[]; invalid: string[] } {
  const entries: AllowEntry[] = [];
  const invalid: string[] = [];
  for (const piece of (raw ?? '').split(',')) {
    const item = piece.trim().toLowerCase();
    if (!item) continue;
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
    else invalid.push(piece.trim());
  }
  return { entries, invalid };
}

function parsePort(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function parseEntry(item: string): AllowEntry | null {
  let host: string;
  let portRaw: string | undefined;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(item);
  if (v6) {
    if (net.isIP(v6[1]!) !== 6) return null;
    host = `[${v6[1]}]`;
    portRaw = v6[2];
  } else {
    const plain = /^([a-z0-9._-]+)(?::(\d{1,5}))?$/.exec(item);
    if (!plain) return null;
    host = plain[1]!;
    portRaw = plain[2];
  }
  const port = parsePort(portRaw);
  if (port === null) return null;
  // Must already be in URL.hostname form (exact match, no surprises such as
  // "2130706433" silently meaning 127.0.0.1 or "[::0:1]" meaning [::1]).
  let canonical: string;
  try {
    canonical = new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
  if (canonical !== host) {
    // IPv6: accept any spelling, store the canonical one.
    if (!host.startsWith('[')) return null;
    host = canonical;
  }
  return port === undefined ? { host } : { host, port };
}

let envList: AllowEntry[] | null = null;

/** OUTBOUND_ALLOW_PRIVATE, parsed once (warns about malformed entries). */
export function allowListFromEnv(): AllowEntry[] {
  if (envList) return envList;
  const { entries, invalid } = parseAllowList(process.env.OUTBOUND_ALLOW_PRIVATE);
  for (const bad of invalid) console.warn(`OUTBOUND_ALLOW_PRIVATE: ignoring malformed entry "${bad}"`);
  if (entries.length > 0) {
    console.log(`outbound: internal addresses allowed for ${entries.map((e) => (e.port ? `${e.host}:${e.port}` : e.host)).join(', ')}`);
  }
  envList = entries;
  return envList;
}

function effectivePort(url: URL): number | null {
  if (url.port) return Number(url.port);
  if (url.protocol === 'https:') return 443;
  if (url.protocol === 'http:') return 80;
  return null;
}

/** Does the URL's host (and port, when the entry names one) match an entry?
 * By the NAME in the URL, never by what it resolves to. */
export function isAllowedUrl(url: URL, list: AllowEntry[] = allowListFromEnv()): boolean {
  const host = url.hostname.toLowerCase();
  const port = effectivePort(url);
  return list.some((e) => e.host === host && (e.port === undefined || e.port === port));
}

/**
 * The allowance a flagged upstream carries (ADR-0020, "Exception per
 * upstream"): exactly its own URL's host and port (default port filled in),
 * from the row's CURRENT url. Unflagged rows, and anything unparseable, get
 * none (fail closed). Callers read it from the row per request; never cache.
 */
export function upstreamAllowance(row: { url: string; allowInternal: boolean }): AllowEntry[] {
  if (row.allowInternal !== true) return [];
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    return [];
  }
  const port = effectivePort(url);
  if (port === null || !url.hostname) return [];
  return [{ host: url.hostname.toLowerCase(), port }];
}

/** The URL's host as an IP literal (brackets stripped), or null for a name. */
function ipLiteral(url: URL): string | null {
  const h = url.hostname;
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);
  return net.isIP(h) === 4 ? h : null;
}

// ---- guarded DNS lookup -----------------------------------------------------------

type LookupAddress = { address: string; family: number };
/** dns.lookup(hostname, { all: true }, cb), injectable for tests. */
export type Resolver = (hostname: string, options: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, options, cb) => dns.lookup(hostname, options, cb);

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for net/tls connect options that refuses internal addresses.
 * Handles both call shapes: `all: false` (address, family) and `all: true`
 * (an array; Node 22's autoSelectFamily asks for that). Always resolves ALL
 * addresses and refuses if any is blocked.
 */
export function makeGuardedLookup(resolve: Resolver = systemResolver) {
  return function guardedLookup(hostname: string, options: unknown, callback?: LookupCallback): void {
    let opts: Record<string, unknown> = {};
    let cb = callback;
    if (typeof options === 'function') cb = options as LookupCallback;
    else if (typeof options === 'number') opts = { family: options };
    else if (options && typeof options === 'object') opts = options as Record<string, unknown>;
    if (!cb) throw new TypeError('lookup needs a callback');
    const done = cb;
    const { all, ...rest } = opts;
    resolve(hostname, { ...(rest as dns.LookupOptions), all: true }, (err, addresses) => {
      if (err) return done(err, all ? [] : '');
      if (!Array.isArray(addresses) || addresses.length === 0) {
        const e = Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException;
        return done(e, all ? [] : '');
      }
      if (addresses.some((a) => (a.family !== 4 && a.family !== 6) || isBlockedAddress(a.address))) {
        logBlocked(hostname);
        return done(new OutboundBlocked(hostname), all ? [] : '');
      }
      if (all) return done(null, addresses);
      return done(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

const guardedLookup = makeGuardedLookup();

// ---- fetch ----------------------------------------------------------------------

// Two dispatchers: hosts on the exception list get a plain one, everything
// else connects through the guarded lookup. The npm `undici` major matches the
// one bundled in Node 22 (6.x), so Node's global fetch accepts its Agent as a
// `dispatcher` (outbound.test.ts proves the lookup really runs).
let guardedDispatcher: Dispatcher | null = null;
let openDispatcher: Dispatcher | null = null;

function dispatcherFor(allowed: boolean): Dispatcher {
  if (allowed) return (openDispatcher ??= new Agent());
  return (guardedDispatcher ??= new Agent({ connect: { lookup: guardedLookup as never } }));
}

function urlOfInput(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

/** Throws OutboundBlocked if the URL's host is a blocked IP literal (and not
 * on the exception list). Names are judged at connect time. */
function precheck(url: URL, list: AllowEntry[]): boolean {
  const allowed = isAllowedUrl(url, list);
  if (allowed) return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundBlocked(url.hostname);
  const literal = ipLiteral(url);
  if (literal !== null && isBlockedAddress(literal)) {
    logBlocked(url.hostname);
    throw new OutboundBlocked(url.hostname);
  }
  return false;
}

function findBlocked(e: unknown): OutboundBlocked | null {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    if (cur instanceof OutboundBlocked) return cur;
    const errors = (cur as { errors?: unknown }).errors; // AggregateError (autoSelectFamily)
    if (Array.isArray(errors)) {
      for (const inner of errors) {
        const found = findBlocked(inner);
        if (found) return found;
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The only `fetch` in apps/api/src. Same contract as fetch, except that
 * redirects are always refused; rejects with OutboundBlocked when the
 * destination is internal. Callers still apply their own timeout/size rules (and limitResponse, which rebuilds the
 * Response with the current global class).
 */
export async function outboundFetch(
  input: string | URL | Request,
  init?: RequestInit,
  opts: {
    /** Replaces the env list (tests). */
    allow?: AllowEntry[];
    /** Added to the env list: a flagged upstream's own host:port (upstreamAllowance). */
    alsoAllow?: AllowEntry[];
  } = {},
): Promise<Response> {
  const url = urlOfInput(input);
  const allowed = precheck(url, [...(opts.allow ?? allowListFromEnv()), ...(opts.alsoAllow ?? [])]);
  try {
    // redirect: 'error' is forced here, not left to callers: the IP-literal
    // check above only sees the first URL, a followed redirect would not pass it.
    return await fetch(input, { ...init, redirect: 'error', dispatcher: dispatcherFor(allowed) } as RequestInit);
  } catch (e) {
    const blocked = findBlocked(e);
    if (blocked) throw blocked;
    throw e;
  }
}

// ---- web push -------------------------------------------------------------------

let guardedHttpsAgent: https.Agent | null = null;
let openHttpsAgent: https.Agent | null = null;

/** The https.Agent web-push must use for this endpoint: guarded lookup unless
 * the host is on the exception list. Throws OutboundBlocked for a blocked IP
 * literal (no lookup happens for those). */
export function pushAgentFor(endpoint: string, list: AllowEntry[] = allowListFromEnv()): https.Agent {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OutboundBlocked('(invalid url)');
  }
  if (precheck(url, list)) return (openHttpsAgent ??= new https.Agent());
  return (guardedHttpsAgent ??= new https.Agent({ lookup: guardedLookup as never }));
}

// ---- save-time check ----------------------------------------------------------

/**
 * UX check when a URL is saved (upstream URL, push endpoint): 'blocked' if the
 * host is a blocked literal or resolves to any blocked address. A name that
 * doesn't resolve is 'ok' (the request-time check still applies). Not the
 * enforcement: DNS can change after this.
 */
export async function checkUrlHost(
  raw: string,
  opts: { allow?: AllowEntry[]; resolve?: Resolver } = {},
): Promise<'ok' | 'blocked'> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'blocked';
  }
  if (isAllowedUrl(url, opts.allow ?? allowListFromEnv())) return 'ok';
  const literal = ipLiteral(url);
  if (literal !== null) return isBlockedAddress(literal) ? 'blocked' : 'ok';
  const resolve = opts.resolve ?? systemResolver;
  const addresses = await new Promise<LookupAddress[] | null>((done) => {
    resolve(url.hostname, { all: true }, (err, addrs) => done(err ? null : addrs));
  });
  if (!addresses || addresses.length === 0) return 'ok';
  return addresses.some((a) => (a.family !== 4 && a.family !== 6) || isBlockedAddress(a.address)) ? 'blocked' : 'ok';
}
