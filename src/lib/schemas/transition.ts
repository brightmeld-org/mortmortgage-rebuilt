// TransitionRequest schema (task-019) — STRICT zod mirror of contracts.json
// TransitionRequest (VR-078..VR-082). Field names and enum literals VERBATIM
// from contracts.json; unknown fields rejected (SEC-18).
//
// Cross-field requirements (VR-080 note-for-revision, VR-081 reason-for-suspend,
// VR-082 recommendation+note for T15) depend on the matched transition and are
// enforced by the engine (src/lib/services/workflow-engine.ts), which knows the
// (fromState, toState) pair — the schema alone cannot know the current state.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** WorkflowState machine names — verbatim from contracts.json enums.WorkflowState. */
export const WORKFLOW_STATE_VALUES = [
  "draft",
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
  "approved",
  "denied",
  "borrower_notified",
  "revision_requested",
  "suspended",
  "withdrawn",
  "declined_by_borrower",
] as const;

/** RecommendationValue — verbatim from contracts.json enums.RecommendationValue. */
export const RECOMMENDATION_VALUES = ["approve", "approve-with-conditions", "deny"] as const;

export const transitionRequestSchema = strictSchema({
  // VR-078: enum-value.
  toState: z.enum(WORKFLOW_STATE_VALUES),
  // VR-079: range 0..2147483647 (stale stamp → 409, decided by the engine).
  versionStamp: z.number().int().min(0).max(2147483647),
  // VR-080: max-length ≤ 4000; REQUIRED for transitions to revision_requested (engine-enforced).
  note: z.string().max(4000).optional(),
  // VR-081: required for transitions to suspended; optional for withdraw (engine-enforced).
  reason: z.string().optional(),
  // VR-082: required for T15 (engine-enforced).
  recommendation: z.enum(RECOMMENDATION_VALUES).optional(),
});

export type TransitionRequestBody = z.infer<typeof transitionRequestSchema>;
