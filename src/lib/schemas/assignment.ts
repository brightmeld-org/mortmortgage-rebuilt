// Assignment request schemas (task-022) — STRICT zod mirrors of contracts.json
// AssignmentRequest / BulkAssignRequest / AutoAssignRequest / ReassignRequest
// (VR-108..VR-115). Field names VERBATIM from contracts.json; unknown fields
// rejected (SEC-18). INV-019's "active CASEWORKER-role user" half of VR-108 is
// a live DB check and lives in the service (src/lib/services/assignment.ts),
// not here.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** POST /api/applications/:id/assignment — contracts.json AssignmentRequest. */
export const assignmentRequestSchema = strictSchema({
  // VR-108: format (uuid).
  caseworkerUserId: z.string().uuid(),
  // VR-109: max-length ≤ 500, optional.
  reason: z.string().max(500).optional(),
});
export type AssignmentRequestBody = z.infer<typeof assignmentRequestSchema>;

/** POST /api/supervisor/assignments/bulk — contracts.json BulkAssignRequest. */
export const bulkAssignRequestSchema = strictSchema({
  // VR-110: required, non-empty array.
  applicationIds: z.array(z.string()).min(1),
  // VR-111: format (uuid).
  caseworkerUserId: z.string().uuid(),
  // VR-112: max-length ≤ 500, optional.
  reason: z.string().max(500).optional(),
});
export type BulkAssignRequestBody = z.infer<typeof bulkAssignRequestSchema>;

/** POST /api/supervisor/assignments/auto — contracts.json AutoAssignRequest. */
export const autoAssignRequestSchema = strictSchema({
  // VR-113 (cross-field): when absent, all unassigned applications are
  // targeted; when present, each id must be unassigned — the per-id
  // "unassigned" half is a live check in the service (per-application result).
  applicationIds: z.array(z.string()).optional(),
});
export type AutoAssignRequestBody = z.infer<typeof autoAssignRequestSchema>;

/** POST /api/applications/:id/reassignment — contracts.json ReassignRequest. */
export const reassignRequestSchema = strictSchema({
  // VR-114: format (uuid).
  caseworkerUserId: z.string().uuid(),
  // VR-115: non-empty — reason is REQUIRED for reassignment.
  reason: z.string().trim().min(1),
});
export type ReassignRequestBody = z.infer<typeof reassignRequestSchema>;
