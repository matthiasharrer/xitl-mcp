// Snooze rows (ADR-0004, TC-30): "don't ask again for this client + tool until".
// Every query is scoped by the owning user. Expired rows are harmless (the
// policy compares `until` with the Clock) and are pruned opportunistically.
import { prisma } from '../db.js';

export interface SnoozeKey {
  userId: number;
  upstreamId: number;
  toolName: string;
  mcpClientId: number;
}

/** The latest `until` of a live snooze for exactly this key, or null. */
export async function liveSnoozeUntil(key: SnoozeKey, now: Date): Promise<Date | null> {
  const row = await prisma.snooze.findFirst({
    where: { ...key, until: { gt: now } },
    orderBy: { until: 'desc' },
    select: { until: true },
  });
  return row?.until ?? null;
}

/** toolName -> latest live `until`, for one client on one upstream (tools/list). */
export async function liveSnoozesFor(userId: number, upstreamId: number, mcpClientId: number, now: Date): Promise<Map<string, Date>> {
  const rows = await prisma.snooze.findMany({
    where: { userId, upstreamId, mcpClientId, until: { gt: now } },
    select: { toolName: true, until: true },
  });
  const out = new Map<string, Date>();
  for (const r of rows) {
    const prev = out.get(r.toolName);
    if (!prev || r.until > prev) out.set(r.toolName, r.until);
  }
  return out;
}

export async function createSnooze(key: SnoozeKey, until: Date, now: Date): Promise<void> {
  await prisma.snooze.deleteMany({ where: { userId: key.userId, until: { lte: now } } });
  await prisma.snooze.create({ data: { ...key, until, createdAt: now } });
}
