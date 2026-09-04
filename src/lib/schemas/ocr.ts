// ApplySuggestionRequest schema (task-035) — STRICT zod mirror of
// contracts.json ApplySuggestionRequest (VR-101..VR-103, VR-130).
//
// fieldPath is only shape-checked here (non-empty, VR-102); membership in the
// extraction's field set and the mapping onto an application scalar are the
// ocr-suggestions service's job.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

export const applySuggestionRequestSchema = strictSchema({
  // VR-130 / §A optimistic concurrency + INV-039 ("every write to an
  // Application — auto-save, transition, submission, CORRECTION-BEARING
  // operations — must carry and verify the version stamp; a stale stamp is
  // rejected 409 and never silently overwrites"). Applying an OCR suggestion
  // IS a correction-bearing write (it routes through recordCorrection), so it
  // carries the client's stamp like the section-save and correction call
  // sites. Same range bound as VR-056 / VR-079 / VR-084 / VR-131.
  versionStamp: z.number().int().min(0).max(2147483647),
  // VR-101: uuid format.
  extractionId: z.string().uuid(),
  // VR-102: non-empty. The 500-char cap is a boundary-safety bound only.
  fieldPath: z.string().min(1).max(500),
  // VR-103: optional free text ≤ 500 chars.
  reason: z.string().max(500).optional(),
});

export type ApplySuggestionRequest = z.infer<typeof applySuggestionRequestSchema>;
