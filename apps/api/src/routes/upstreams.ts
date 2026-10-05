import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { RESERVED_SLUGS, SLUG_PATTERN } from '../lib/slugs.js';
import type { Upstream } from '../generated/prisma/client.js';
import { externalOrigin } from '../lib/externalOrigin.js';
import { checkUrlHost } from '../lib/outbound.js';
import { ConnectError, finishConnect, startConnect, errorTag } from '../upstream/oauthClient.js';
import { approvals } from '../approval/pending.js';
import { createTokenClient } from './mcpClients.js';
import { systemClock } from '../lib/clock.js';

// /api/upstreams: the user's registry of upstream MCP servers (ADR-0013).
// Mounted under /api, so it sits behind the identity middleware. Every query is
// scoped by `userId` (ADR-0010): someone else's upstream answers 404, exactly
// like a missing one (no oracle).
//
// The Upstream row holds credentials (tokens, header value, OAuth client). The
// ONE serializer below is the only way a row leaves this file: it whitelists
// fields and never spreads the row (TC-07).
export const upstreams = new Hono<AppEnv>();

export function serializeUpstream(row: Upstream) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    description: row.description,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    defaultPolicy: row.defaultPolicy,
    auth: row.auth,
    status: row.status,
    headerName: row.headerName,
    allowInternal: row.allowInternal,
    // The value itself is write-only: it never leaves the server.
    hasHeaderValue: row.headerValue !== null && row.headerValue !== '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const slugSchema = z
  .string({ error: 'Der Slug fehlt.' })
  .regex(SLUG_PATTERN, 'Der Slug darf nur aus Kleinbuchstaben, Ziffern und Bindestrichen bestehen (1 bis 32 Zeichen, nicht mit Bindestrich beginnen).')
  .refine((s) => !RESERVED_SLUGS.includes(s), 'Dieser Slug ist reserviert.');

const urlSchema = z
  .string({ error: 'Die URL fehlt.' })
  .trim()
  .max(2000, 'Die URL ist zu lang.')
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
    } catch {
      return false;
    }
  }, 'Die URL muss mit http:// oder https:// beginnen.');

export const nameSchema = z
  .string({ error: 'Der Name fehlt.' })
  .trim()
  .min(1, 'Der Name darf nicht leer sein.')
  .max(100, 'Der Name ist zu lang (höchstens 100 Zeichen).');

const descriptionSchema = z
  .string({ error: 'Die Beschreibung ist ungültig.' })
  .trim()
  .max(1000, 'Die Beschreibung ist zu lang (höchstens 1000 Zeichen).')
  .nullable();

const policySchema = z.enum(['ALLOW', 'ASK', 'DENY'], { error: 'Die Standard-Regel muss ALLOW, ASK oder DENY sein.' });
const authSchema = z.enum(['OAUTH', 'HEADER', 'NONE'], { error: 'Die Anmeldung muss OAUTH, HEADER oder NONE sein.' });

// RFC 9110 token characters: what a header name may consist of.
const headerNameSchema = z
  .string({ error: 'Der Header-Name fehlt.' })
  .trim()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, 'Der Header-Name ist ungültig.');
// No control characters (header injection) and non-empty.
const headerValueSchema = z
  .string({ error: 'Der Header-Wert fehlt.' })
  .min(1, 'Der Header-Wert darf nicht leer sein.')
  .max(4000, 'Der Header-Wert ist zu lang.')
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'Der Header-Wert enthält ungültige Zeichen.');

const createSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema,
    url: urlSchema,
    description: descriptionSchema.optional(),
    defaultPolicy: policySchema.default('ASK'),
    auth: authSchema.default('OAUTH'),
    headerName: headerNameSchema.nullish(),
    headerValue: headerValueSchema.nullish(),
    allowInternal: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.auth === 'HEADER') {
      if (!v.headerName) ctx.addIssue({ code: 'custom', path: ['headerName'], message: 'Der Header-Name fehlt.' });
      if (!v.headerValue) ctx.addIssue({ code: 'custom', path: ['headerValue'], message: 'Der Header-Wert fehlt.' });
    }
  });

const patchSchema = z.object({
  name: nameSchema.optional(),
  slug: slugSchema.optional(),
  url: urlSchema.optional(),
  description: descriptionSchema.optional(),
  defaultPolicy: policySchema.optional(),
  auth: authSchema.optional(),
  headerName: headerNameSchema.nullish(),
  headerValue: headerValueSchema.nullish(),
  allowInternal: z.boolean().optional(),
});

/** Save-time half of ADR-0020 (UX only; the request-time guard in
 * lib/outbound.ts is the enforcement). */
export const BLOCKED_URL =
  'Diese Adresse liegt im internen Netz. xitl ruft sie nur auf, wenn du es für diesen Upstream ausdrücklich erlaubst.';

/**
 * ADR-0020, "Exception per upstream": the flag to store for `url`, or a 400
 * body. Internal + confirmed -> true; internal + not confirmed -> refused;
 * not internal -> false (a public URL never gets the flag, even if asked).
 */
async function internalFlag(url: string, confirmed: boolean | undefined): Promise<{ flag: boolean } | { refused: { error: string; code: 'internal_address' } }> {
  const internal = (await checkUrlHost(url)) === 'blocked';
  if (!internal) return { flag: false };
  if (confirmed === true) return { flag: true };
  return { refused: { error: BLOCKED_URL, code: 'internal_address' } };
}

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'no-store');
}

function parseId(raw: string | undefined): number | null {
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

export function firstMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Die Eingabe ist ungültig.';
}

const SLUG_TAKEN = 'Diesen Slug hast du schon vergeben.';

/** PATCH of a HEADER upstream's URL without a new header value (ADR-0021). */
export const HEADER_VALUE_REQUIRED = {
  error: 'Neue Adresse: Bitte gib den Header-Wert neu ein.',
  code: 'header_value_required',
} as const;

const clock = systemClock;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

upstreams.get('/', async (c) => {
  noStore(c);
  const rows = await prisma.upstream.findMany({
    where: { userId: c.get('user').id },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return c.json(rows.map(serializeUpstream));
});

upstreams.post('/', async (c) => {
  noStore(c);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: firstMessage(parsed.error) }, 400);
  const v = parsed.data;
  const userId = c.get('user').id;
  const internal = await internalFlag(v.url, v.allowInternal);
  if ('refused' in internal) return c.json(internal.refused, 400);

  const clash = await prisma.upstream.findUnique({ where: { userId_slug: { userId, slug: v.slug } } });
  if (clash) return c.json({ error: SLUG_TAKEN }, 409);

  try {
    const row = await prisma.upstream.create({
      data: {
        userId,
        name: v.name,
        slug: v.slug,
        url: v.url,
        allowInternal: internal.flag,
        description: v.description ? v.description : null,
        defaultPolicy: v.defaultPolicy,
        auth: v.auth,
        headerName: v.auth === 'HEADER' ? v.headerName! : null,
        headerValue: v.auth === 'HEADER' ? v.headerValue! : null,
        // HEADER/NONE need no connect step (ADR-0013); OAUTH waits for one.
        status: v.auth === 'OAUTH' ? 'NOT_CONNECTED' : 'CONNECTED',
      },
    });
    return c.json(serializeUpstream(row), 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: SLUG_TAKEN }, 409);
    throw e;
  }
});

// ---- Connecting an OAUTH upstream (ADR-0013, TC-15/16) ----
//
// POST /:id/connect starts the flow and returns the upstream AS's authorize
// URL for the browser; the AS sends the browser back to GET /oauth/callback,
// which is under /api and so behind Authelia + identity: the callback is
// redeemed as the logged-in user, and only against that user's own upstream
// (finishConnect). The redirect URI is derived from our public origin.

const CALLBACK_PATH = '/api/upstreams/oauth/callback';

upstreams.post('/:id/connect', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'Nicht gefunden.' }, 404);
  const row = await prisma.upstream.findFirst({ where: { id, userId: c.get('user').id } });
  if (!row) return c.json({ error: 'Nicht gefunden.' }, 404);
  if (row.auth !== 'OAUTH') return c.json({ error: 'Dieser Upstream braucht keine Verbindung.' }, 400);
  try {
    const authorizationUrl = await startConnect(row, `${externalOrigin(c)}${CALLBACK_PATH}`);
    return c.json({ authorizationUrl });
  } catch (e) {
    if (e instanceof ConnectError) return c.json({ error: e.message }, 502);
    console.warn(`upstream ${id}: connect failed: ${errorTag(e)}`);
    return c.json({ error: 'Die Verbindung konnte nicht gestartet werden.' }, 502);
  }
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

upstreams.get('/oauth/callback', async (c) => {
  noStore(c);
  const q = c.req.query();
  const result = await finishConnect(c.get('user').id, { state: q.state, code: q.code, iss: q.iss, error: q.error });
  if (result.kind === 'bad') {
    return c.html(
      `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>xitl: Verbindung fehlgeschlagen</title><body style="font-family:system-ui;padding:1rem">` +
        `<h1 style="font-size:1.25rem">Verbindung fehlgeschlagen</h1><p>${escapeHtml(result.message)}</p>` +
        `<p><a href="/#/einstellungen">Zurück zu den Einstellungen</a></p></body></html>`,
      400,
    );
  }
  // Relative: the browser stays on whatever origin it reached us through.
  const target =
    result.kind === 'connected'
      ? `/#/einstellungen?verbunden=${result.upstreamId}`
      : `/#/einstellungen?verbindung=${result.reason}&upstream=${result.upstreamId}`;
  return c.redirect(target, 302);
});

upstreams.get('/:id', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'Nicht gefunden.' }, 404);
  const row = await prisma.upstream.findFirst({ where: { id, userId: c.get('user').id } });
  return row ? c.json(serializeUpstream(row)) : c.json({ error: 'Nicht gefunden.' }, 404);
});

upstreams.patch('/:id', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'Nicht gefunden.' }, 404);
  const userId = c.get('user').id;

  const existing = await prisma.upstream.findFirst({ where: { id, userId } });
  if (!existing) return c.json({ error: 'Nicht gefunden.' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: firstMessage(parsed.error) }, 400);
  const v = parsed.data;
  const data: Record<string, unknown> = {};
  const urlChanged = v.url !== undefined && v.url !== existing.url;
  // A changed URL recomputes the flag (re-confirm); an unchanged one keeps it.
  if (urlChanged) {
    const internal = await internalFlag(v.url!, v.allowInternal);
    if ('refused' in internal) return c.json(internal.refused, 400);
    data.allowInternal = internal.flag;
  }
  if (v.name !== undefined) data.name = v.name;
  if (v.slug !== undefined) data.slug = v.slug;
  if (v.description !== undefined) data.description = v.description ? v.description : null;
  if (v.defaultPolicy !== undefined) data.defaultPolicy = v.defaultPolicy;

  const auth = v.auth ?? existing.auth;
  if (auth === 'HEADER') {
    const headerName = v.headerName ?? existing.headerName;
    // ADR-0021: the stored secret was given for the OLD address; a new
    // address must come with the value again, or nothing changes. Without a
    // URL change a missing headerValue keeps the stored one (write-only field).
    if (urlChanged && !v.headerValue) return c.json(HEADER_VALUE_REQUIRED, 400);
    const headerValue = v.headerValue ?? existing.headerValue;
    if (!headerName) return c.json({ error: 'Der Header-Name fehlt.' }, 400);
    if (!headerValue) return c.json({ error: 'Der Header-Wert fehlt.' }, 400);
    data.headerName = headerName;
    data.headerValue = headerValue;
  } else {
    data.headerName = null;
    data.headerValue = null;
  }
  data.auth = auth;

  // A different server or a different way to log in invalidates whatever
  // connection existed: tokens for the old one must not be sent to the new one.
  const authChanged = auth !== existing.auth;
  if (v.url !== undefined) data.url = v.url;
  if (urlChanged || authChanged) {
    Object.assign(data, {
      status: auth === 'OAUTH' ? 'NOT_CONNECTED' : 'CONNECTED',
      oauthClient: null,
      oauthMetadata: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      pendingAuth: null,
    });
  }

  if (v.slug !== undefined && v.slug !== existing.slug) {
    const clash = await prisma.upstream.findUnique({ where: { userId_slug: { userId, slug: v.slug } } });
    if (clash) return c.json({ error: SLUG_TAKEN }, 409);
  }

  try {
    const found = await prisma.$transaction(async (tx) => {
      const res = await tx.upstream.updateMany({ where: { id, userId }, data });
      if (res.count === 0) return false;
      // Another server behind the same name (ADR-0021): nothing the user
      // reviewed or paused applies to it. Every tool counts as CHANGED, so an
      // explicit tool/client ALLOW becomes ASK "changed-tool" until the user
      // acknowledges the tool or sets its policy (lib/policy.ts); the
      // policies themselves are kept. Every pause of this upstream ends.
      if (urlChanged) {
        await tx.knownTool.updateMany({
          where: { upstreamId: id, upstream: { userId } },
          data: { acknowledgedAt: null, changedAt: clock.now() },
        });
        await tx.snooze.deleteMany({ where: { upstreamId: id, userId } });
      }
      return true;
    });
    if (!found) return c.json({ error: 'Nicht gefunden.' }, 404);
    // A held call was approved for the old server / login: never forward it
    // to the new one.
    if (urlChanged || authChanged) approvals.cancelWhere((call) => call.userId === userId && call.upstreamId === id);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: SLUG_TAKEN }, 409);
    throw e;
  }
  const row = await prisma.upstream.findFirst({ where: { id, userId } });
  return row ? c.json(serializeUpstream(row)) : c.json({ error: 'Nicht gefunden.' }, 404);
});

upstreams.delete('/:id', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'Nicht gefunden.' }, 404);
  const userId = c.get('user').id;
  const res = await prisma.upstream.deleteMany({ where: { id, userId } });
  if (res.count === 0) return c.json({ error: 'Nicht gefunden.' }, 404);
  // Its held calls end denied right away ("+revoked", TC-41).
  approvals.cancelWhere((call) => call.userId === userId && call.upstreamId === id);
  return c.body(null, 204);
});

// POST /api/upstreams/:id/tokens - body { name } -> 201 { client, token }
// (ADR-0015). The ONLY response that ever contains the token; only its SHA-256
// is stored. The new row is an McpClient of kind TOKEN, bound at creation to
// this user and this upstream. Someone else's upstream is a 404.
upstreams.post('/:id/tokens', async (c) => {
  noStore(c);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'Nicht gefunden.' }, 404);
  const userId = c.get('user').id;
  const upstream = await prisma.upstream.findFirst({ where: { id, userId }, select: { id: true } });
  if (!upstream) return c.json({ error: 'Nicht gefunden.' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ name: nameSchema }).safeParse(body);
  if (!parsed.success) return c.json({ error: firstMessage(parsed.error) }, 400);

  const { client, token } = await createTokenClient(userId, parsed.data.name, { upstreamId: upstream.id });
  return c.json({ client, token }, 201);
});
