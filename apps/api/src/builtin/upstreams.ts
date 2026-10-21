// list_upstreams of the built-in `xitl` upstream (ADR-0037): the user's
// upstreams' basic metadata. A whitelist: slug, name, description, state,
// tool count, last call. Never the URL, auth kind, credentials, OAuth data,
// default policy, tool rules, AUTO rule, instructions or allowInternal.
import { prisma } from '../db.js';
import { storedState } from '../upstream/connection.js';
import { berlinIso } from './history.js';

export type UpstreamStateLabel = 'aktiv' | 'pausiert' | 'nicht verbunden' | 'neu verbinden' | 'nicht erreichbar';

const LABEL = {
  ok: 'aktiv',
  'not-connected': 'nicht verbunden',
  reconnect: 'neu verbinden',
  unreachable: 'nicht erreichbar',
} as const;

/** The state as the app shows it: a pause wins (ADR-0033: off on purpose),
 * then the stored connection state (ADR-0022). Nothing is contacted. */
export function stateLabel(row: Parameters<typeof storedState>[0] & { pausedAt: Date | null }): UpstreamStateLabel {
  if (row.pausedAt !== null) return 'pausiert';
  return LABEL[storedState(row)];
}

export async function listUpstreams(userId: number) {
  const rows = await prisma.upstream.findMany({
    where: { userId },
    orderBy: [{ slug: 'asc' }, { id: 'asc' }],
    select: { id: true, slug: true, name: true, description: true, auth: true, status: true, accessToken: true, lastFailureAt: true, pausedAt: true },
  });
  const ids = rows.map((r) => r.id);
  // The page's tool count is the known tools of the upstream (routes/upstreamTools.ts).
  const [counts, lasts] = await Promise.all([
    prisma.knownTool.groupBy({ by: ['upstreamId'], where: { upstreamId: { in: ids }, upstream: { userId } }, _count: { _all: true } }),
    prisma.auditEntry.groupBy({ by: ['upstreamId'], where: { userId, upstreamId: { in: ids } }, _max: { receivedAt: true } }),
  ]);
  const countOf = new Map(counts.map((c) => [c.upstreamId, c._count._all]));
  const lastOf = new Map(lasts.map((l) => [l.upstreamId, l._max.receivedAt]));
  return {
    upstreams: rows.map((r) => {
      const last = lastOf.get(r.id) ?? null;
      return {
        slug: r.slug,
        name: r.name,
        description: r.description,
        state: stateLabel(r),
        toolCount: countOf.get(r.id) ?? 0,
        lastCallAt: last ? berlinIso(last) : null,
      };
    }),
  };
}
