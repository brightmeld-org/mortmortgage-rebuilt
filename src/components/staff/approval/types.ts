// Client-side constants for the approval decision panel (task-032).
// EVERY enum literal is copied VERBATIM from contracts.json — do not rename,
// reorder beyond the contract's declaration order, or extend.

/**
 * contracts.json enums.DenialReason (the HMDA adverse-action set, VR-087) with
 * the §4.6.6 display labels. The `value` strings are the wire values sent in
 * ApprovalDecisionRequest.denialReasons — byte-for-byte from the contract.
 */
export const DENIAL_REASONS = [
  { value: "dti", label: "Debt-to-income ratio" },
  { value: "employment-history", label: "Employment history" },
  { value: "credit-history", label: "Credit history" },
  { value: "collateral", label: "Collateral" },
  { value: "insufficient-cash", label: "Insufficient cash (down payment, closing costs)" },
  { value: "unverifiable-information", label: "Unverifiable information" },
  { value: "application-incomplete", label: "Credit application incomplete" },
  { value: "mortgage-insurance-denied", label: "Mortgage insurance denied" },
  { value: "other", label: "Other (specify)" },
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number]["value"];

/** VR-087: a deny decision carries 1–4 HMDA reasons. */
export const MAX_DENIAL_REASONS = 4;

/**
 * Client-side mirror of the INV-001 different-approver rule for the CURRENT
 * viewer, derived from the supervisor list's viewer-relative approvalStatus
 * labels (src/lib/services/supervisor-list.ts approvalStatusFor — itself
 * computed by approval.ts evaluateLevel2DecisionEligibility, the SAME rule the
 * decision gate enforces). "unknown" = the probe failed or returned an
 * unrecognized label — the panel FAILS OPEN (actions enabled) because the
 * server gate remains authoritative and its 403/409 is surfaced verbatim.
 */
export type Level2Eligibility =
  | "loading"
  | "eligible"
  | "self-l1-approver"
  | "no-l1-approve"
  | "unknown";

/** Exact viewer-relative labels emitted by the supervisor list service. */
export function eligibilityFromApprovalStatus(label: string | undefined): Level2Eligibility {
  if (label === "Needs Level-2 · eligible") return "eligible";
  if (label === "Needs Level-2 · you recorded Level-1") return "self-l1-approver";
  if (label === "Needs Level-2") return "no-l1-approve";
  return "unknown";
}

/** §4.6.6 ineligibility explanations (mirror the gate's 403/409 messages). */
export const INELIGIBILITY_COPY: Record<"self-l1-approver" | "no-l1-approve", string> = {
  "self-l1-approver":
    "You recorded the Level-1 approval on this application. The Level-2 decision must be made by a different Supervisor.",
  "no-l1-approve":
    "No Level-1 approve is recorded for this version — a Level-2 decision requires a Level-1 approval.",
};
