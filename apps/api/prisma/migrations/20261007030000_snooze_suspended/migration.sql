-- ADR-0029 amendment (2026-10-15): a KI-Prüfung mismatch interrupts an allow
-- pause instead of deleting it; null = active. An interrupted row lets nothing
-- through (approval/snooze.ts liveRows) until the human resumes it.
ALTER TABLE "Snooze" ADD COLUMN "suspendedAt" DATETIME;
