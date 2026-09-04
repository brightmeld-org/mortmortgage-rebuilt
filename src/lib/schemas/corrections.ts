// Correction request schema (task-023) — STRICT zod mirror of contracts.json
// CorrectionRequest (VR-089..VR-092).
//
// fieldPath itself is only shape-checked here (non-empty string, VR-089); the
// grammar (dot/bracket path), target-field existence, and the per-field
// type/enum/range validation of `newValue` (VR-091) are the corrections
// service's job (src/lib/services/corrections.ts) because they depend on the
// stored data layout.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

export const correctionRequestSchema = strictSchema({
  // §A optimistic concurrency + INV-039 ("every write to an Application —
  // auto-save, transition, submission, CORRECTION-BEARING operations — must
  // carry and verify the version stamp; a stale stamp is rejected 409 and never
  // silently overwrites") and the §B error set for this endpoint, which lists
  // 409. Same range bound as VR-056 / VR-079 / VR-084 — the one mechanism the
  // section-save and transition call sites already use.
  versionStamp: z.number().int().min(0).max(2147483647),
  // VR-089: non-empty. The 500-char cap is a boundary-safety bound (the deepest
  // contracted path is far shorter); it is not a contract constant.
  fieldPath: z.string().min(1).max(500),
  // VR-090: range 1..2.
  borrowerOrdinal: z.number().int().min(1).max(2).optional(),
  // VR-091: max-length ≤ 10000 — JSON-encoded scalar, validated against the
  // target field's schema before applying (service).
  newValue: z.string().max(10000),
  // VR-092: required free text ≤ 500 chars (blank-only rejected).
  reason: z
    .string()
    .max(500)
    .refine((s) => s.trim().length > 0, { message: "reason is required" }),
});

export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;

// ProposedHousingExpense lives in schemas/application.ts (single canonical
// shape) now that the loan-details section payload also writes it.
