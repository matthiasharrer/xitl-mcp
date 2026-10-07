// ADR-0030 §5 helpers for writing an AUTO rule. Mounted under /api/upstreams
// (identity: Remote-User). Every handler resolves the upstream among the
// CALLER's upstreams first (404 otherwise, no oracle). None of them changes
// anything: the rule itself is only saved by PATCH /api/upstreams/:id.
//
//   POST /:id/auto-rule/draft    "Vorschlag": the intent model drafts a text
//                                from the stored tool list -> { draft }.
//                                Model off -> 409; model failure -> 502.
//   GET  /:id/auto-rule/history  "Mit Verlauf testen", step 1: the caller's
//                                own newest ≤ 50 audit rows of this upstream
//                                (ids, tool, time, outcome; no arguments).
//   POST /:id/auto-rule/test     step 2, one row at a time (the UI runs them
//                                sequentially and can stop): { rule, auditId }
//                                -> { auditId, result: pass|below|error, score }.
//                                The row must be the caller's and this
//                                upstream's (404 otherwise). Read-only: no
//                                audit/policy write, nothing forwarded, the
//                                outage notice untouched. Clef off -> 409.
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { AUTO_DRAFT_MAX_TOOLS, AUTO_TEST_MAX_ROWS, MAX_AUTO_RULE_CHARS } from '../lib/limits.js';
import { autoGate as defaultAutoGate } from '../auto/index.js';
import type { AutoGate } from '../auto/gate.js';
import { draftMessages, parseDraft } from '../auto/draft.js';
import { intentModel as defaultModel } from '../intent/index.js';
import { intentTimeoutFromEnv, type IntentModel } from '../intent/model.js';
import { withTimeout } from '../clef/client.js';

const NOT_FOUND = { error: 'Nicht gefunden.' };

function parseId(raw: string | undefined): number | null {
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}
function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const testSchema = z
  .object({
    rule: z.string().trim().min(1, 'Die Auto-Regel ist leer.').max(MAX_AUTO_RULE_CHARS, `Die Auto-Regel ist zu lang (höchstens ${MAX_AUTO_RULE_CHARS} Zeichen).`),
    auditId: z.number().int().positive(),
  })
  .strict();

export function makeAutoRuleRoutes(deps: { gate?: AutoGate; model?: IntentModel | null; draftTimeoutMs?: number } = {}) {
  const gate = deps.gate ?? defaultAutoGate;
  const model = deps.model === undefined ? defaultModel : deps.model;
  const draftTimeoutMs = deps.draftTimeoutMs ?? intentTimeoutFromEnv(process.env.INTENT_LLM_TIMEOUT_MS);
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  const own = (id: number | null, userId: number) =>
    id === null ? null : prisma.upstream.findFirst({ where: { id, userId }, select: { id: true, name: true } });

  r.post('/:id/auto-rule/draft', async (c) => {
    const up = await own(parseId(c.req.param('id')), c.get('user').id);
    if (!up) return c.json(NOT_FOUND, 404);
    if (!model) return c.json({ error: 'Vorschläge sind nicht eingerichtet.' }, 409);
    const tools = await prisma.knownTool.findMany({
      where: { upstreamId: up.id },
      select: { name: true, description: true, annotations: true },
      orderBy: { name: 'asc' },
      take: AUTO_DRAFT_MAX_TOOLS,
    });
    if (tools.length === 0) return c.json({ error: 'Noch keine Tools bekannt. „Tools aktualisieren“ holt sie.' }, 409);
    const res = await withTimeout(draftTimeoutMs, (signal) =>
      model.complete(draftMessages(up.name, tools.map((t) => ({ name: t.name, description: t.description, annotations: parseJson(t.annotations) }))), signal),
    );
    const draft = 'value' in res ? parseDraft(res.value.text) : null;
    if (!draft) {
      console.warn(`auto: draft failed (${'error' in res ? (res.timedOut ? 'timeout' : res.error instanceof Error ? res.error.name : 'unknown') : 'unusable answer'})`);
      return c.json({ error: 'Der Vorschlag hat nicht geklappt. Versuch es später noch einmal.' }, 502);
    }
    return c.json({ draft });
  });

  r.get('/:id/auto-rule/history', async (c) => {
    const userId = c.get('user').id;
    const up = await own(parseId(c.req.param('id')), userId);
    if (!up) return c.json(NOT_FOUND, 404);
    const rows = await prisma.auditEntry.findMany({
      where: { userId, upstreamId: up.id },
      orderBy: { id: 'desc' },
      take: AUTO_TEST_MAX_ROWS,
      select: { id: true, toolName: true, receivedAt: true, outcome: true },
    });
    return c.json({
      available: await gate.active(userId),
      entries: rows.map((a) => ({ id: a.id, tool: a.toolName, receivedAt: a.receivedAt.toISOString(), outcome: a.outcome })),
    });
  });

  r.post('/:id/auto-rule/test', async (c) => {
    const userId = c.get('user').id;
    const up = await own(parseId(c.req.param('id')), userId);
    if (!up) return c.json(NOT_FOUND, 404);
    const parsed = testSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Die Eingabe ist ungültig.' }, 400);
    const row = await prisma.auditEntry.findFirst({
      where: { id: parsed.data.auditId, userId, upstreamId: up.id },
      select: { id: true, toolName: true, arguments: true },
    });
    if (!row) return c.json(NOT_FOUND, 404);
    if (!(await gate.active(userId))) return c.json({ error: 'Die KI-Prüfung ist aus.' }, 409);
    const tool = await prisma.knownTool.findFirst({ where: { upstreamId: up.id, name: row.toolName }, select: { description: true, annotations: true } });
    const result = await gate.ask(parsed.data.rule, {
      upstream: up.name,
      tool: row.toolName,
      description: tool?.description ?? null,
      annotations: tool ? parseJson(tool.annotations) : null,
      args: parseJson(row.arguments),
    });
    const kind = result.kind === 'pass' || result.kind === 'below' ? result.kind : 'error';
    return c.json({ auditId: row.id, result: kind, score: 'score' in result ? result.score : null });
  });
  return r;
}

export const autoRule = makeAutoRuleRoutes();
