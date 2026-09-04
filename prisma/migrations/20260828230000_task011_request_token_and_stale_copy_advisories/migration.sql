-- task-011: application-create idempotency + persistent section-copy staleness advisories.
--
-- SEC-21 / NFR-022: CreateApplicationRequest.requestToken must never create two
-- applications. The token is persisted on the created Application and made unique per
-- borrower, so a replay returns the existing row and a concurrent duplicate create loses
-- the insert race (unique violation) instead of double-creating. NULLs are ignored by the
-- Postgres unique index, so seed/legacy rows without a token are unaffected.
ALTER TABLE "Application" ADD COLUMN "createRequestToken" TEXT;

-- REQ-022: section-copy staleness advisories persist until the borrower edits the section
-- or explicitly confirms it (VR-068). JSON array of { section, sourceSavedAt, message }.
ALTER TABLE "Application" ADD COLUMN "staleCopyAdvisories" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE UNIQUE INDEX "Application_borrowerUserId_createRequestToken_key"
  ON "Application"("borrowerUserId", "createRequestToken");
