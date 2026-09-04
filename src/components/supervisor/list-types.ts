// Client-side wire types for the supervisor all-applications surface
// (task-031). Field names mirror contracts.json QueueRow (supervisor
// projection) / SupervisorSummaryCards / SupervisorApplicationPage /
// AssignmentResult / BulkAssignResponse / AssignmentInfo / StaffAccountRow
// verbatim — do not rename.

import type { Priority, QueueRow, WorkflowState } from "@/components/caseworker/types";

export type { Priority, WorkflowState };

/** contracts.json models.QueueRow — with the two supervisor-only fields. */
export interface SupervisorQueueRow extends QueueRow {
  assignedCaseworkerName?: string;
  approvalStatus?: string;
}

export interface SupervisorSummaryCards {
  total: number;
  draft: number;
  inUnderwriting: number;
  pendingApproval: number;
  approved: number;
  denied: number;
  withdrawn: number;
  thisMonth: number;
}

export interface SupervisorApplicationPage {
  rows: SupervisorQueueRow[];
  cards: SupervisorSummaryCards;
  page: number;
  pageSize: number;
  total: number;
}

/** contracts.json models.AssignmentResult / BulkAssignResponse. */
export interface AssignmentResult {
  applicationId: string;
  success: boolean;
  error?: string;
}

export interface BulkAssignResponse {
  results: AssignmentResult[];
}

/** contracts.json models.AssignmentInfo — fields this surface reads. */
export interface AssignmentInfo {
  id: string;
  applicationId: string;
  caseworkerUserId: string;
  caseworkerName: string;
  assignedByName?: string;
  method: "claim" | "manual" | "bulk" | "auto" | "reassign";
  reason?: string;
  assignedAt: string;
  endedAt?: string;
  endReason?: string;
}

export interface AssignmentList {
  rows: AssignmentInfo[];
}

/** contracts.json models.StaffAccountRow — fields this surface reads. */
export interface StaffAccountRow {
  id: string;
  firstName: string;
  lastName: string;
  role: "CASEWORKER" | "SUPERVISOR";
  status: "active" | "inactive";
}

export interface StaffListResponse {
  rows: StaffAccountRow[];
}

export const PRIORITY_VALUES: readonly Priority[] = ["urgent", "high", "normal", "low"];

/** INV-032: Suspended may only be entered from states 2–8. */
export const SUSPENDABLE_STATES: readonly WorkflowState[] = [
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
];
