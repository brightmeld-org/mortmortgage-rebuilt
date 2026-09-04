-- task-036 (ASM-009 / ASYNC-002): additive retry bookkeeping on Notification.
-- deliveryAttempts = completed external delivery attempts (max 3 automatic);
-- nextAttemptAt = persisted backoff schedule driving the WALK-002 retry scan.
ALTER TABLE "Notification" ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Notification" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
