// ApprovalDecisionRequest schema (task-020) — STRICT zod mirror of
// contracts.json ApprovalDecisionRequest (VR-083..VR-088). Field names and enum
// literals VERBATIM from contracts.json; unknown fields rejected (SEC-18).
//
// State-independent cross-field rules (VR-086/087/088) are enforced HERE via
// superRefine — they depend only on the body. State-dependent semantics (which
// level, which transition, deny-only states) are the approval gate's
// (src/lib/services/approval.ts), which knows the current workflow state.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** ApprovalDecision — verbatim from contracts.json enums.ApprovalDecision. */
export const APPROVAL_DECISION_VALUES = ["approve", "deny"] as const;

/** DenialReason — verbatim from contracts.json enums.DenialReason (HMDA set). */
export const DENIAL_REASON_VALUES = [
  "dti",
  "employment-history",
  "credit-history",
  "collateral",
  "insufficient-cash",
  "unverifiable-information",
  "application-incomplete",
  "mortgage-insurance-denied",
  "other",
] as const;

const baseSchema = strictSchema({
  // VR-083: enum-value.
  decision: z.enum(APPROVAL_DECISION_VALUES),
  // VR-084: range 0..2147483647 (stale stamp → 409, decided by the gate).
  versionStamp: z.number().int().min(0).max(2147483647),
  // VR-085: max-length ≤ 4000.
  notes: z.string().max(4000).optional(),
  // VR-086: free-text condition list — only valid with decision approve.
  conditions: z.array(z.string().trim().min(1)).optional(),
  // VR-087: 1-4 HMDA reasons, required with deny, forbidden with approve.
  denialReasons: z.array(z.enum(DENIAL_REASON_VALUES)).optional(),
  // VR-088: required when denialReasons contains 'other'.
  denialReasonOtherText: z.string().trim().min(1).max(4000).optional(),
});

export const approvalDecisionRequestSchema = baseSchema.superRefine((body, ctx) => {
  if (body.decision === "approve") {
    // VR-087: denialReasons forbidden with approve.
    if (body.denialReasons !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["denialReasons"],
        message: "denial reasons are only valid with a deny decision",
      });
    }
    if (body.denialReasonOtherText !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["denialReasonOtherText"],
        message: "denial reason text is only valid with a deny decision",
      });
    }
  } else {
    // VR-086: conditions only valid with approve.
    if (body.conditions !== undefined && body.conditions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conditions"],
        message: "conditions are only valid with an approve decision",
      });
    }
    // VR-087: 1-4 HMDA reasons required with deny.
    if (!body.denialReasons || body.denialReasons.length < 1 || body.denialReasons.length > 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["denialReasons"],
        message: "a deny decision requires 1 to 4 HMDA denial reasons",
      });
    } else {
      if (new Set(body.denialReasons).size !== body.denialReasons.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["denialReasons"],
          message: "denial reasons must not repeat",
        });
      }
      // VR-088: denialReasonOtherText required when denialReasons contains other.
      const hasOther = body.denialReasons.includes("other");
      if (hasOther && !body.denialReasonOtherText) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["denialReasonOtherText"],
          message: "denial reason text is required when denial reasons include other",
        });
      }
      if (!hasOther && body.denialReasonOtherText !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["denialReasonOtherText"],
          message: "denial reason text is only valid when denial reasons include other",
        });
      }
    }
  }
});

export type ApprovalDecisionRequestBody = z.infer<typeof approvalDecisionRequestSchema>;
