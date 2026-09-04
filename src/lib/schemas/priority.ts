// PriorityRequest schema (task-021) — STRICT zod mirror of contracts.json
// PriorityRequest (VR-116/VR-117). Field names and enum literals VERBATIM from
// contracts.json; unknown fields rejected (SEC-18).

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** Priority — verbatim from contracts.json enums.Priority. */
export const PRIORITY_VALUES = ["urgent", "high", "normal", "low"] as const;

export const priorityRequestSchema = strictSchema({
  // VR-116: enum-value.
  priority: z.enum(PRIORITY_VALUES),
  // VR-117: max-length ≤ 500, optional.
  reason: z.string().max(500).optional(),
});

export type PriorityRequestBody = z.infer<typeof priorityRequestSchema>;
