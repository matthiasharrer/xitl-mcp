// /api/running: "Läuft gerade" (TC-178…183), the caller's active time-based
// decisions across all upstreams and accesses. Mounted under /api (Authelia
// identity). Everything is scoped by the CALLER: another user's rows never
// appear and can never be ended from here.
//
//   GET    /          { pauses: live Snooze rows (allow = Zeitfreigabe, deny =
//                       Sperre), soonest end first; paused: accesses with
//                       pausedAt set (ADR-0024), oldest first;
//                       pausedUpstreams: upstreams with pausedAt set
//                       (ADR-0033), oldest first }. No arguments,
//                       no credentials: names, scope, times and the human's
//                       "Wofür?" only.
//   DELETE /pauses    "Alle beenden": ends every Zeitfreigabe and Sperre of the
//                       caller (paused accesses and upstreams stay; they are
//                       resumed one by one via PATCH /api/mcp/clients/:id and
//                       PATCH /api/upstreams/:id). -> { ended: n }
//
// Ending one entry reuses DELETE /api/upstreams/:id/snoozes/:snoozeId; a change
// is announced on the approval stream as `running` (lib/pauseEvents.ts).
import { Hono } from 'hono';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { pauseEvents as defaultEvents, type PauseEvents } from '../lib/pauseEvents.js';

export function makeRunningRoutes(clock: Clock = systemClock, events: PauseEvents = defaultEvents) {
  const r = new Hono<AppEnv>();

  r.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  r.get('/', async (c) => {
    const userId = c.get('user').id;
    const now = clock.now();
    const [rows, clients, upstreams] = await Promise.all([
      prisma.snooze.findMany({
        where: { userId, until: { gt: now } },
        select: {
          id: true,
          effect: true,
          scope: true,
          toolName: true,
          until: true,
          createdAt: true,
          purpose: true,
          purposeSource: true,
          upstream: { select: { id: true, name: true } },
          mcpClient: { select: { id: true, name: true } },
        },
        orderBy: [{ until: 'asc' }, { id: 'asc' }],
      }),
      prisma.mcpClient.findMany({
        where: { userId, pausedAt: { not: null } },
        select: { id: true, name: true, pausedAt: true },
        orderBy: [{ pausedAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.upstream.findMany({
        where: { userId, pausedAt: { not: null } },
        select: { id: true, name: true, pausedAt: true },
        orderBy: [{ pausedAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return c.json({
      pauses: rows.map((p) => ({
        id: p.id,
        // Anything but exactly ALLOW is a Sperre (snooze.ts isAllow).
        effect: p.effect === 'ALLOW' ? ('ALLOW' as const) : ('DENY' as const),
        scope: p.scope,
        toolName: p.toolName,
        upstream: p.upstream,
        client: p.mcpClient,
        until: p.until.toISOString(),
        createdAt: p.createdAt.toISOString(),
        purpose: p.purpose,
        purposeSource: p.purpose ? (p.purposeSource === 'suggested' ? 'suggested' : 'typed') : null,
      })),
      paused: clients.map((cl) => ({ id: cl.id, name: cl.name, pausedAt: cl.pausedAt!.toISOString() })),
      pausedUpstreams: upstreams.map((u) => ({ id: u.id, name: u.name, pausedAt: u.pausedAt!.toISOString() })),
    });
  });

  r.delete('/pauses', async (c) => {
    const userId = c.get('user').id;
    const ended = await prisma.snooze.count({ where: { userId, until: { gt: clock.now() } } });
    // Expired rows of the caller go too (they are inert anyway).
    await prisma.snooze.deleteMany({ where: { userId } });
    events.emit({ userId });
    return c.json({ ended });
  });

  return r;
}

export const running = makeRunningRoutes();
