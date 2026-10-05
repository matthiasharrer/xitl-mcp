// Cleanup of unbound OAuth clients (TC-88). `/mcp/register` (DCR) is public, so
// anyone can create McpClient rows of kind OAUTH; such a row only becomes
// useful once a user approves it on the consent page (userId set, ADR-0012).
// Rows nobody approved are deleted after UNBOUND_CLIENT_TTL_MS, and at most
// MAX_UNBOUND_CLIENTS of them are kept (oldest evicted first). Bound clients
// and TOKEN clients are never touched: every delete is conditional on
// `kind OAUTH, userId null` at the moment it runs, so a client approved in
// between survives.
//
// A pruned client_id behaves like any unknown one: the consent page shows
// "Unbekannter oder abgelaufener client_id-Parameter." (400) and the token
// endpoint answers invalid_grant. An unbound client can't hold a code or
// token anyway (both are minted only after binding).
import { prisma } from '../db.js';
import { MAX_UNBOUND_CLIENTS, UNBOUND_CLIENT_TTL_MS } from '../lib/limits.js';

export interface PruneOptions {
  maxAgeMs?: number;
  maxUnbound?: number;
  /** Slots to leave free below `maxUnbound`: 1 right before a registration
   * creates a row, so that afterwards there are at most `maxUnbound`. */
  reserve?: number;
}

/**
 * Which unbound clients to delete: every one created more than `maxAgeMs`
 * before `now` (exactly `maxAgeMs` old stays), then, among the rest, the
 * oldest (by createdAt, ties by id) until at most `maxUnbound - reserve`
 * remain. Pure; `rows` must be unbound OAUTH clients only.
 */
export function unboundClientsToPrune(
  rows: { id: number; createdAt: Date }[],
  now: Date,
  opts: PruneOptions = {},
): number[] {
  const maxAgeMs = opts.maxAgeMs ?? UNBOUND_CLIENT_TTL_MS;
  const keep = Math.max(0, (opts.maxUnbound ?? MAX_UNBOUND_CLIENTS) - (opts.reserve ?? 0));
  const cutoff = now.getTime() - maxAgeMs;
  const expired = rows.filter((r) => r.createdAt.getTime() < cutoff);
  const live = rows
    .filter((r) => r.createdAt.getTime() >= cutoff)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const evicted = live.slice(0, Math.max(0, live.length - keep));
  return [...expired, ...evicted].map((r) => r.id);
}

/** Deletes unbound OAUTH clients per `unboundClientsToPrune`; returns how many
 * rows were deleted. Runs before every registration and once at boot. */
export async function pruneUnboundClients(now: Date, opts: PruneOptions = {}): Promise<number> {
  const unbound = { kind: 'OAUTH' as const, userId: null };
  const rows = await prisma.mcpClient.findMany({ where: unbound, select: { id: true, createdAt: true } });
  const ids = unboundClientsToPrune(rows, now, opts);
  if (ids.length === 0) return 0;
  const res = await prisma.mcpClient.deleteMany({ where: { ...unbound, id: { in: ids } } });
  if (res.count > 0) console.log(`oauth: ${res.count} unbound client(s) removed`);
  return res.count;
}
