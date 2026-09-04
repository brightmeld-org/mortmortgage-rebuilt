-- task-025 / INV-031 / ASYNC-005 (serial-per-key uw-check:{applicationId}:{checkType}):
-- at most ONE UnderwritingResult may be in `running` per (application, check type).
-- The database is the single authority on duplicate in-flight runs — a concurrent
-- second POST hits unique_violation (P2002) and is "ignored server-side" (§4.6.5):
-- the endpoint returns the existing running row. Additive only; Prisma cannot
-- express partial indexes in the schema, so this raw index is the declaration.
CREATE UNIQUE INDEX "UnderwritingResult_app_type_running_key"
  ON "UnderwritingResult" ("applicationId", "checkType")
  WHERE "status" = 'running';
