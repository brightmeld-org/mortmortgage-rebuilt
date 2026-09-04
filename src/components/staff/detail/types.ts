// Client-side wire types for the staff application detail surface (task-029).
// EVERY field name and enum literal is copied verbatim from contracts.json —
// do not rename or extend. Shapes already mirrored for the borrower surfaces
// are re-exported from src/components/borrower/types.ts rather than duplicated.

import type { WorkflowState } from "@/components/borrower/types";

export type {
  ApplicationWire,
  ApplicationDataWire,
  AddressWire,
  BorrowerRecordWire,
  ChecklistItemWire,
  DocumentListResponse,
  DocumentRequestInfo,
  DocumentRequestList,
  DocumentStatus,
  DocumentType,
  DocumentWire,
  DocumentVersionInfoWire,
  Outcome,
  WorkflowState,
  WorkflowHistoryInfo,
  WorkflowHistoryPage,
} from "@/components/borrower/types";

// ---------------------------------------------------------------------------
// Staff-editable states (§4.5.1 "Staff-edit" column / §4.4.4 verbatim list:
// Application Received, Completeness Validated, Supporting Documents Received,
// AUS Executed, Preliminary Decision). Mirrors STAFF_EDITABLE_STATES in
// src/lib/services/corrections.ts (server-only module) — the SERVER remains
// authoritative (409 outside these states); this list only decides whether the
// UI renders the inline-correction affordance vs read-only fields.
// ---------------------------------------------------------------------------

export const STAFF_EDITABLE_STATES: readonly WorkflowState[] = [
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
];

export function isStaffEditableState(state: WorkflowState): boolean {
  return STAFF_EDITABLE_STATES.includes(state);
}

/** §4.6 SEC-21: checks may run in workflow states 3–8. */
export const CHECKS_PERMITTED_STATES: readonly WorkflowState[] = [
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
];

// ---------------------------------------------------------------------------
// Decision-gate transition ids (§B transition-endpoint semantics, verbatim:
// "Decision transitions T19–T26b, T31, T40 are NOT reachable through this
// endpoint — they execute exclusively through POST
// /api/applications/:id/approval-decision"). Used only to ROUTE panel entries
// (transition endpoint vs approval panel) — never to re-derive validity, which
// always comes from Application.availableTransitions.
// ---------------------------------------------------------------------------

export const DECISION_GATE_TRANSITION_IDS: ReadonlySet<string> = new Set([
  "T19",
  "T20",
  "T21",
  "T22",
  "T26",
  "T26a",
  "T26b",
  "T31",
  "T40",
]);

// ---------------------------------------------------------------------------
// CorrectionInfo / CorrectionPage (contracts.json models)
// ---------------------------------------------------------------------------

export interface CorrectionInfo {
  id: string;
  applicationId: string;
  fieldPath: string;
  borrowerOrdinal?: number;
  beforeValue?: string;
  afterValue: string;
  correctedByName: string;
  correctedByRole: string;
  correctedAt: string;
  reason: string;
}

export interface CorrectionPage {
  rows: CorrectionInfo[];
  page: number;
  pageSize: number;
  total: number;
}

// ---------------------------------------------------------------------------
// FraudFlagInfo / FraudFlagList (contracts.json models + enums)
// ---------------------------------------------------------------------------

export type FraudFlagSeverity = "low" | "medium" | "high";
export type FraudFlagStatus = "open" | "resolved" | "dismissed";
export type FraudFlagType =
  | "ocr-mismatch"
  | "income-variance"
  | "avm-low"
  | "duplicate-ssn"
  | "employer-unverified";

export interface FraudFlagInfo {
  id: string;
  applicationId: string;
  type: FraudFlagType;
  severity: FraudFlagSeverity;
  sourceDocumentVersionId?: string;
  sourceResultId?: string;
  details: string;
  status: FraudFlagStatus;
  resolvedByName?: string;
  resolutionNote?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface FraudFlagList {
  rows: FraudFlagInfo[];
}

// ---------------------------------------------------------------------------
// ConditionInfo / ApprovalRecordInfo / ApprovalList (contracts.json models)
// ---------------------------------------------------------------------------

export type ConditionStatus = "open" | "cleared";

export interface ConditionInfo {
  id: string;
  applicationId: string;
  approvalRecordId: string;
  text: string;
  status: ConditionStatus;
  clearedByName?: string;
  clearedAt?: string;
}

export interface ApprovalRecordInfo {
  id: string;
  applicationId: string;
  level: number;
  decision: "approve" | "deny";
  approverName: string;
  notes?: string;
  conditions?: ConditionInfo[];
  denialReasons?: string[];
  denialReasonOtherText?: string;
  criteriaEvaluated?: string[];
  dtiAtDecision?: number;
  ltvAtDecision?: number;
  versionNumber: number;
  createdAt: string;
}

export interface ApprovalList {
  rows: ApprovalRecordInfo[];
}

// ---------------------------------------------------------------------------
// AssignmentInfo / AssignmentList (contracts.json models) — supervisor-only
// ---------------------------------------------------------------------------

export interface AssignmentInfoWire {
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
  rows: AssignmentInfoWire[];
}

// ---------------------------------------------------------------------------
// TransitionRequest.recommendation (contracts.json enums.RecommendationValue)
// ---------------------------------------------------------------------------

export const RECOMMENDATION_VALUES = ["approve", "approve-with-conditions", "deny"] as const;
export type RecommendationValue = (typeof RECOMMENDATION_VALUES)[number];

// ---------------------------------------------------------------------------
// DocumentType enum (contracts.json enums.DocumentType, verbatim) for the
// Request-document dialog select.
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = [
  "w2",
  "pay-stub",
  "bank-statement",
  "tax-return-1040",
  "government-id",
  "gift-letter",
  "purchase-agreement",
  "homeowners-insurance-quote",
  "other",
] as const;

// ---------------------------------------------------------------------------
// Correction plumbing shared by the data tabs
// ---------------------------------------------------------------------------

/** Value kind for JSON-encoding CorrectionRequest.newValue. */
export type FieldKind = "string" | "number" | "boolean";

/** One correctable field as the tabs describe it to the correction modal. */
export interface CorrectableField {
  /** Contract fieldPath (dot/bracket, e.g. "loan.requestedLoanAmount"). */
  fieldPath: string;
  /** BorrowerRecord ordinal for borrower-scoped paths; absent for shared. */
  borrowerOrdinal?: number;
  kind: FieldKind;
  label: string;
  /** Raw current value (pre-format) shown in the modal. */
  currentValue: unknown;
}

/**
 * data-testid-safe form of a fieldPath ("." and "[n]" become "-"), prefixed
 * b{ordinal}- for borrower-scoped paths so the two borrowers' identical paths
 * stay unique. Extension within the §C StaffApplicationDetail namespace.
 */
export function fieldPathTestId(fieldPath: string, borrowerOrdinal?: number): string {
  const flat = fieldPath.replace(/\[(\d+)\]/g, "-$1").replace(/\./g, "-");
  return borrowerOrdinal !== undefined ? `b${borrowerOrdinal}-${flat}` : flat;
}

/** Correction lookup key: ordinal-scoped fieldPath. */
export function correctionKey(fieldPath: string, borrowerOrdinal?: number): string {
  return `${borrowerOrdinal ?? "shared"}:${fieldPath}`;
}

/** Latest correction per field (rows arrive newest-first from the API). */
export function buildCorrectionMap(rows: CorrectionInfo[]): Map<string, CorrectionInfo> {
  const map = new Map<string, CorrectionInfo>();
  for (const row of rows) {
    const key = correctionKey(row.fieldPath, row.borrowerOrdinal);
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

/** What the tabs need to render corrections: lookup + edit affordance. */
export interface CorrectionsContext {
  /** Latest correction per correctionKey(). */
  byField: Map<string, CorrectionInfo>;
  /** True only in staff-editable states (server stays authoritative). */
  canCorrect: boolean;
  /** Opens the correction modal for one field. */
  openEditor: (field: CorrectableField) => void;
}
