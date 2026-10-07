// The user's current upstream faults (ADR-0022): what the Freigaben page shows
// as "Störung" cards. Only names and states, never an error text, URL or
// status code (ADR-0007). Read from the stored state; nothing is contacted.
// A paused upstream (ADR-0033) has no card: it is off on purpose.
import { prisma } from '../db.js';
import { storedState } from './connection.js';

export interface UpstreamFault {
  id: number;
  name: string;
  state: 'reconnect' | 'unreachable';
  /** ISO time of the first failure of this run (unreachable only), else null. */
  since: string | null;
}

export async function faultList(userId: number): Promise<UpstreamFault[]> {
  const rows = await prisma.upstream.findMany({
    where: { userId, pausedAt: null },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, auth: true, status: true, accessToken: true, lastFailureAt: true },
  });
  return rows.flatMap((u): UpstreamFault[] => {
    const state = storedState(u);
    if (state !== 'reconnect' && state !== 'unreachable') return [];
    return [{ id: u.id, name: u.name, state, since: state === 'unreachable' ? (u.lastFailureAt?.toISOString() ?? null) : null }];
  });
}
