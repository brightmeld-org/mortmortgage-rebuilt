// Request schemas for the task-033 staff-management endpoints — contracts §E
// VR-120..VR-123, mirrored EXACTLY (field names and enum literals verbatim from
// contracts.json). Strict: unknown JSON fields are rejected (SEC-18).

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** contracts.json enums.StaffRole — verbatim literals. */
export const STAFF_ROLE_VALUES = ["CASEWORKER", "SUPERVISOR"] as const;

// --- §E InviteStaffRequest (VR-120..VR-123) ---
export const inviteStaffRequestSchema = strictSchema({
  firstName: z.string().min(1, "must be non-empty"), // VR-120
  lastName: z.string().min(1, "must be non-empty"), // VR-121
  email: z.string().email("must be a valid email address"), // VR-122
  role: z.enum(STAFF_ROLE_VALUES), // VR-123 — enum-value, literals verbatim
});

export type InviteStaffRequest = z.infer<typeof inviteStaffRequestSchema>;
