-- ADR-0025 amendment (TC-126): a 3-5 word German title from the model, shown
-- as the headline. Advisory, like the summary.
ALTER TABLE "AuditEntry" ADD COLUMN "intentTitle" TEXT;
