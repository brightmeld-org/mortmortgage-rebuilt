// Request schemas for the task-007 MFA endpoints — contracts §E VR-015..VR-020,
// mirrored EXACTLY (field names verbatim from contracts.json: MfaEnrollVerifyRequest,
// MfaVerifyRequest, MfaReenrollRequest). All schemas are strict: unknown JSON fields
// are rejected (SEC-18) via the shared strictSchema helper; cross-field rules use
// .superRefine() per the build convention.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** Shared VR-016/017 & VR-019/020 cross-field rule: exactly one of code | recoveryCode. */
function exactlyOneFactor(
  data: { code?: string; recoveryCode?: string },
  ctx: z.RefinementCtx,
): void {
  const hasCode = data.code !== undefined;
  const hasRecovery = data.recoveryCode !== undefined;
  if (hasCode === hasRecovery) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasCode ? "recoveryCode" : "code"],
      message: "exactly one of code or recoveryCode must be present",
    });
  }
}

// --- §E MfaEnrollVerifyRequest (VR-015) ---
export const mfaEnrollVerifyRequestSchema = strictSchema({
  code: z.string().min(6, "must be at least 6 characters"), // VR-015 — 6-digit TOTP code
});

// --- §E MfaVerifyRequest (VR-016/VR-017) ---
export const mfaVerifyRequestSchema = strictSchema({
  code: z.string().min(1, "must be non-empty").optional(),
  recoveryCode: z.string().min(1, "must be non-empty").optional(),
}).superRefine(exactlyOneFactor);

// --- §E MfaReenrollRequest (VR-018..VR-020) — also the recovery-codes/regenerate body ---
export const mfaReenrollRequestSchema = strictSchema({
  currentPassword: z.string().min(1, "must be non-empty"), // VR-018
  code: z.string().min(1, "must be non-empty").optional(),
  recoveryCode: z.string().min(1, "must be non-empty").optional(),
}).superRefine(exactlyOneFactor); // VR-019/VR-020
