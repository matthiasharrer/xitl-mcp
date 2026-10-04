// Prisma 7 dropped the built-in Rust query engine, so a driver adapter is
// mandatory. For SQLite that's @prisma/adapter-better-sqlite3, built
// from DATABASE_URL. Prisma no longer auto-loads `.env`, so we load it here
// before reading the URL — this module is the first thing every entry point
// (index.ts, seed, routes) reaches for the client, so loading it here covers
// them all. In production and e2e, DATABASE_URL is set in the environment and
// dotenv leaves it untouched (it never overrides an existing var).
import 'dotenv/config';
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set — cannot open the database.');
}

const adapter = new PrismaBetterSqlite3({ url });
export const prisma = new PrismaClient({ adapter });

/**
 * Enable SQLite WAL mode for better read/write concurrency with a single
 * writer. Safe to run on every startup — it's idempotent.
 */
export async function initDb(): Promise<void> {
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys=ON;');
}
