// Client-side wire types for the caseworker queue surfaces (task-028).
// Field names mirror contracts.json QueueRow / QueuePage / CaseworkerStats /
// CompletionHistoryRow / CompletionHistoryPage verbatim — do not rename.

export type WorkflowState =
  | "draft"
  | "application_received"
  | "completeness_validated"
  | "documents_received"
  | "aus_executed"
  | "preliminary_decision"
  | "escalated_review"
  | "conditional_approval"
  | "approved"
  | "denied"
  | "borrower_notified"
  | "revision_requested"
  | "suspended"
  | "withdrawn"
  | "declined_by_borrower";

export type Priority = "urgent" | "high" | "normal" | "low";
export type SlaStatus = "on-track" | "at-risk" | "overdue";
export type LoanType = "conventional" | "fha" | "va" | "usda";

export interface QueueRow {
  applicationId: string;
  applicationNumber: string;
  borrowerDisplayName: string;
  loanAmount?: number;
  loanType?: LoanType;
  submittedAt?: string;
  workflowState: WorkflowState;
  workflowStateLabel: string;
  priority: Priority;
  slaStatus: SlaStatus;
  daysInState: number;
  lastActivityAt?: string;
  openFraudFlagCount?: number;
}

export interface QueuePage {
  rows: QueueRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CaseworkerStats {
  queueSize: number;
  completedThisMonth: number;
  avgDaysToDecision90d: number;
  approvalRatePct90d: number;
  overdueCount: number;
}

export interface CompletionHistoryRow {
  applicationId: string;
  applicationNumber: string;
  outcomeLabel: string;
  daysToDecision: number;
  decidedAt: string;
}

export interface CompletionHistoryPage {
  rows: CompletionHistoryRow[];
  page: number;
  pageSize: number;
  total: number;
}

/** contracts.json models.AssignmentInfo (claim 201 response) — fields we read. */
export interface AssignmentInfo {
  id: string;
  applicationId: string;
  caseworkerUserId: string;
  caseworkerName: string;
  assignedAt: string;
}
