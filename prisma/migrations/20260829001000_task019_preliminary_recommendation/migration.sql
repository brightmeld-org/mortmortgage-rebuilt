-- task-019 (ADDITIVE): storage for the T15 preliminary recommendation (VR-082, WF-017).
-- The contract requires the recommendation to be recorded at T15 (aus_executed ->
-- preliminary_decision) and read by the approval panel (task-032), but defines no
-- wire/model field for it — this nullable column is the internal storage location.
-- Nothing existing is altered or dropped.
ALTER TABLE "Application" ADD COLUMN "preliminaryRecommendation" TEXT;

-- RecommendationValue enum values verbatim from contracts.json.
ALTER TABLE "Application" ADD CONSTRAINT "Application_preliminaryRecommendation_check"
  CHECK ("preliminaryRecommendation" IS NULL OR "preliminaryRecommendation" IN ('approve', 'approve-with-conditions', 'deny'));
