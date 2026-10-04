-- Data only (no schema change): HEADER and NONE upstreams need no connect step
-- (ADR-0013), so they are CONNECTED from now on. Rows created before the
-- upstream-connect slice were stored as NOT_CONNECTED.
UPDATE "Upstream" SET "status" = 'CONNECTED' WHERE "auth" IN ('HEADER', 'NONE') AND "status" = 'NOT_CONNECTED';
