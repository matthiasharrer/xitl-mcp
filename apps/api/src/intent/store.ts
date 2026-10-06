// The intent queue's DB side (queue.ts IntentStore) and the boot sweep.
// Every query is scoped by the call's user.
import { prisma } from '../db.js';
import type { Clock } from '../lib/clock.js';
import { IntentQueue, type IntentResult, type IntentStore } from './queue.js';
import type { IntentModel } from './model.js';

export const prismaIntentStore: IntentStore = {
  async loadCall(auditId, userId) {
    const a = await prisma.auditEntry.findFirst({
      where: { id: auditId, userId },
      select: {
        id: true,
        userId: true,
        mcpClientId: true,
        sessionId: true,
        receivedAt: true,
        upstreamId: true,
        toolName: true,
        arguments: true,
        upstream: { select: { name: true } },
      },
    });
    if (!a) return null;
    const tool =
      a.upstreamId !== null
        ? await prisma.knownTool.findFirst({
            where: { upstreamId: a.upstreamId, name: a.toolName, upstream: { userId } },
            select: { description: true, annotations: true },
          })
        : null;
    return {
      id: a.id,
      userId: a.userId,
      mcpClientId: a.mcpClientId,
      sessionId: a.sessionId,
      receivedAt: a.receivedAt,
      upstreamId: a.upstreamId,
      upstreamName: a.upstream?.name ?? null,
      toolName: a.toolName,
      arguments: a.arguments,
      description: tool?.description ?? null,
      annotations: tool?.annotations ?? null,
    };
  },

  async predecessor(call) {
    if (!call.sessionId && call.mcpClientId === null) return null;
    return prisma.auditEntry.findFirst({
      where: {
        userId: call.userId,
        id: { lt: call.id },
        ...(call.sessionId ? { sessionId: call.sessionId } : { mcpClientId: call.mcpClientId, sessionId: null }),
      },
      orderBy: { id: 'desc' },
      select: { id: true, mcpClientId: true, sessionId: true, receivedAt: true, intentContextId: true },
    });
  },

  async contextTurns(userId, contextId) {
    const rows = await prisma.auditEntry.findMany({
      where: { userId, intentContextId: contextId, intentStatus: 'DONE', intentPrompt: { not: null }, intentAnswer: { not: null } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        upstreamId: true,
        toolName: true,
        intentPrompt: true,
        intentAnswer: true,
        outcome: true,
        policy: true,
        decisionPath: true,
        isError: true,
        resultText: true,
      },
    });
    return rows.map((r) => ({ ...r, intentPrompt: r.intentPrompt!, intentAnswer: r.intentAnswer! }));
  },

  async save(auditId, r: IntentResult) {
    await prisma.auditEntry.updateMany({
      where: { id: auditId },
      data:
        r.status === 'DONE'
          ? {
              intentStatus: 'DONE',
              intentTitle: r.title,
              intentSummary: r.summary,
              intentRisk: r.risk,
              intentModelRisk: r.modelRisk,
              intentLowered: r.lowered,
              intentModel: r.model,
              intentAt: r.at,
              intentPrompt: r.prompt,
              intentAnswer: r.answer,
              intentContextId: r.contextId,
            }
          : {
              intentStatus: 'FAILED',
              intentModel: r.model,
              intentAt: r.at,
              intentPrompt: r.prompt,
              intentContextId: r.contextId,
            },
    });
  },

  async skip(auditIds) {
    if (auditIds.length === 0) return;
    await prisma.auditEntry.updateMany({ where: { id: { in: auditIds }, intentStatus: 'PENDING' }, data: { intentStatus: 'SKIPPED' } });
  },
};

/** Boot (single replica): nothing is queued in a fresh process, so rows still
 * PENDING were cut off by a restart. They are never summarized. */
export async function sweepIntents(db: { $executeRaw: typeof prisma.$executeRaw } = prisma): Promise<number> {
  return db.$executeRaw`UPDATE "AuditEntry" SET "intentStatus" = 'SKIPPED' WHERE "intentStatus" = 'PENDING'`;
}

export function makeIntentQueue(opts: { model: IntentModel | null; clock?: Clock; timeoutMs?: number }): IntentQueue {
  return new IntentQueue({ ...opts, store: prismaIntentStore });
}
