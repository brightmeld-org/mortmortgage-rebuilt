-- task-034 / ASYNC-001 / ASYNC-004 (document-ocr worker) — additive only.
--
-- 1. nextRetryAt: the PERSISTED exponential-backoff schedule (30s * 2^(attempt-1))
--    for automatic retries. A failed attempt with retries remaining records WHEN
--    the job becomes due again; the scheduler/reconciler requeues (failed -> queued,
--    the contract FSM transition) only when nextRetryAt <= now. NULL means "no
--    automatic retry pending" (completed, final failure, or manually superseded).
ALTER TABLE "DocumentJob" ADD COLUMN "nextRetryAt" TIMESTAMP(3);

-- Due-retry scan (scheduler): failed jobs whose nextRetryAt has passed.
CREATE INDEX "DocumentJob_status_nextRetryAt_idx" ON "DocumentJob"("status", "nextRetryAt");

-- 2. Serial-per-key (ASYNC-001 idempotency key document-ocr:{documentVersionId}):
--    at most ONE DocumentJob may be active (queued or processing) per document
--    version. The database is the single authority on duplicate in-flight jobs —
--    a concurrent manual Retry hits unique_violation (P2002) and receives the
--    EXISTING active job (202, idempotent-while-in-flight). Prisma cannot express
--    partial indexes in the schema, so this raw index is the declaration
--    (task-025 INV-031 precedent).
CREATE UNIQUE INDEX "DocumentJob_version_active_key"
  ON "DocumentJob" ("documentVersionId")
  WHERE "status" IN ('queued', 'processing');
