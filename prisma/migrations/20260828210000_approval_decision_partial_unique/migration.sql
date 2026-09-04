-- task-020 (approval gate): INV-017 × WF-037/WF-046 reconciliation.
--
-- The init migration created a FULL unique index on
-- ApprovalRecord(applicationId, versionNumber, level). That index makes the
-- contracted T31/T40 transitions unimplementable: WF-037 ("Conditional
-- Approval → Denied ... requires ... deny ApprovalRecord at highest level
-- previously required") and WF-046 must write a deny record at a
-- (applicationId, versionNumber, level) slot that ALREADY holds the approve
-- record which produced conditional_approval (T20/T26a) — a guaranteed
-- unique-violation on the mainline flow.
--
-- Resolution (reported in the task-020 build report): split the constraint
-- into two PARTIAL unique indexes, one per decision value. This preserves
-- everything INV-017 exists for:
--   * "Duplicate L1 records would let a later approve shadow an earlier deny"
--     — still impossible: at most one APPROVE per (application, version,
--     level), and the approval gate (INV-028) treats any deny record at a
--     required level as permanently disqualifying regardless of approve rows.
--   * Race authority for concurrent same-level decision attempts: two
--     concurrent approves (or two concurrent denies) still collide on the
--     index (P2002 → contracted 409). Approve-vs-deny races are serialized by
--     the versionStamp WHERE-clause guard, because the record insert and the
--     workflow transition commit in ONE transaction (task-020 gate).
-- while permitting the deny-after-approve row that T31/T40 mandate.
--
-- Same raw-SQL partial-index pattern as the INV-016 one-active index in the
-- init migration; the Prisma model carries a plain @@index on the triple.

DROP INDEX "ApprovalRecord_applicationId_versionNumber_level_key";

CREATE INDEX "ApprovalRecord_applicationId_versionNumber_level_idx"
  ON "ApprovalRecord"("applicationId", "versionNumber", "level");

CREATE UNIQUE INDEX "ApprovalRecord_app_version_level_approve_key"
  ON "ApprovalRecord"("applicationId", "versionNumber", "level")
  WHERE "decision" = 'approve';

CREATE UNIQUE INDEX "ApprovalRecord_app_version_level_deny_key"
  ON "ApprovalRecord"("applicationId", "versionNumber", "level")
  WHERE "decision" = 'deny';
