import { serve } from '@hono/node-server';
import { app } from './app.js';
import { initDb, prisma } from './db.js';
import { approvals } from './approval/pending.js';
import { systemClock } from './lib/clock.js';
import { allowListFromEnv } from './lib/outbound.js';
import { pruneUnboundClients } from './mcp/unboundClients.js';

const port = Number(process.env.PORT ?? 3002);

await initDb();
// Parse OUTBOUND_ALLOW_PRIVATE now, so malformed entries warn at boot (ADR-0020).
allowListFromEnv();

// Single replica: at boot no call can be in flight. Rows still PENDING were
// cut off by a crash or kill (a clean shutdown finishes them). The agent got
// no result; a held call was never approved. Record them as DENIED with
// "+restart" (an ALLOW call may have reached the upstream before the crash;
// the path says the outcome is unknown, not that it was refused).
const swept = await prisma.$executeRaw`UPDATE "AuditEntry" SET "outcome" = 'DENIED', "decisionPath" = "decisionPath" || '+restart', "finishedAt" = ${systemClock.now()} WHERE "outcome" = 'PENDING'`;
if (swept > 0) console.warn(`audit: ${swept} unfinished call(s) from before the restart marked DENIED`);
// DCR clients nobody approved: expired ones and any over the cap (TC-88).
await pruneUnboundClients(systemClock.now());

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

// PID 1 in the container ignores SIGTERM without a handler; also lets SQLite
// checkpoint its WAL on shutdown.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down.`);
    // Held calls are denied (fail closed) and their audit rows finished before
    // the DB goes away; open approval streams are ended so close() can finish.
    approvals.shutdown();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    // Idle keep-alive sockets (and anything stuck) must not block the exit.
    setTimeout(() => (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(), 3000).unref();
  });
}
