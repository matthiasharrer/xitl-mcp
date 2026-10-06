-- ADR-0026: a snooze (pause) is ALLOW (today's) or DENY. Plain text, not an
-- enum: the code treats any value other than exactly 'ALLOW' as DENY (fail
-- closed, snooze.ts).
ALTER TABLE "Snooze" ADD COLUMN "effect" TEXT NOT NULL DEFAULT 'ALLOW';
