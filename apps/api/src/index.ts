import { serve } from '@hono/node-server';
import { app } from './app.js';
import { initDb, prisma } from './db.js';

const port = Number(process.env.PORT ?? 3002);

await initDb();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

// PID 1 in the container ignores SIGTERM without a handler; also lets SQLite
// checkpoint its WAL on shutdown.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down.`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
