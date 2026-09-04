// Workflow-state STATIC MAP + lookups — PURE (task-011).
//
// Scope discipline: this module is ONLY the contracts.md §A "Workflow State
// Transitions" table as data, plus derived read-side lookups:
//   - WORKFLOW_STATE_LABELS  (§4.5.1 human labels — "unknown" must never appear)
//   - WORKFLOW_TRANSITIONS   (the exhaustive, fixed (from, to, actors) table)
//   - availableTransitions(state, role)  → toState machine names for the caller
//     (Application.availableTransitions / ErrorResponse.allowedTransitions)
//   - state-class predicates used across features (borrower-editable, active,
//     terminal, claimable-adjacent logic stays in guard.ts).
// The transition ENGINE (executing transitions, preconditions, side effects) is
// task-019 and is deliberately NOT here.
//
// Pure-function rules: no Prisma, no fetch, no Date, deterministic.

import type { WorkflowState, UserRole } from "@prisma/client";

// ---------------------------------------------------------------------------
// §4.5.1 human-readable labels (used consistently everywhere; never "unknown")
// ---------------------------------------------------------------------------

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  draft: "Draft",
  application_received: "Application Received",
  completeness_validated: "Completeness & Consistency Validated",
  documents_received: "Supporting Documents Received",
  aus_executed: "AUS Executed",
  preliminary_decision: "Preliminary Decision",
  escalated_review: "Escalated Review",
  conditional_approval: "Conditional Approval",
  approved: "Approved",
  denied: "Denied",
  borrower_notified: "Borrower Notified",
  revision_requested: "Revision Requested",
  suspended: "Suspended",
  withdrawn: "Withdrawn",
  declined_by_borrower: "Declined by Borrower",
};

export function workflowStateLabel(state: WorkflowState): string {
  return WORKFLOW_STATE_LABELS[state];
}

// ---------------------------------------------------------------------------
// The §A transition table, verbatim, as data
// ---------------------------------------------------------------------------

/** Actor legend from the contract table: B / C / S / SYS. */
export type TransitionActor = "B" | "C" | "S" | "SYS";

export interface WorkflowTransition {
  /** Transition id from the contract table (T1, T26a, ...). */
  id: string;
  from: WorkflowState;
  to: WorkflowState;
  /** Actors allowed to take this transition per the §A table. */
  actors: readonly TransitionActor[];
}

/**
 * The exhaustive, fixed transition table (contracts.md §A "Workflow State
 * Transitions"). Anything unlisted is rejected 409 (WF-047, INV-033).
 * Decision transitions (T19-T22, T26/T26a/T26b, T31, T40) execute only through
 * the approval-decision gate and T27/T28 are SYS-only — that ROUTING rule
 * belongs to task-019/020; the map itself lists every pair verbatim.
 */
export const WORKFLOW_TRANSITIONS: readonly WorkflowTransition[] = [
  // draft
  { id: "T1", from: "draft", to: "application_received", actors: ["B"] },
  { id: "T2", from: "draft", to: "withdrawn", actors: ["B"] },
  // application_received
  { id: "T3", from: "application_received", to: "completeness_validated", actors: ["C", "S"] },
  { id: "T4", from: "application_received", to: "revision_requested", actors: ["C", "S"] },
  { id: "T5", from: "application_received", to: "withdrawn", actors: ["B"] },
  { id: "T6", from: "application_received", to: "suspended", actors: ["S"] },
  // completeness_validated
  { id: "T7", from: "completeness_validated", to: "documents_received", actors: ["C", "S"] },
  { id: "T8", from: "completeness_validated", to: "revision_requested", actors: ["C", "S"] },
  { id: "T9", from: "completeness_validated", to: "withdrawn", actors: ["B"] },
  { id: "T10", from: "completeness_validated", to: "suspended", actors: ["S"] },
  // documents_received
  { id: "T11", from: "documents_received", to: "aus_executed", actors: ["C", "S"] },
  { id: "T12", from: "documents_received", to: "revision_requested", actors: ["C", "S"] },
  { id: "T13", from: "documents_received", to: "withdrawn", actors: ["B"] },
  { id: "T14", from: "documents_received", to: "suspended", actors: ["S"] },
  // aus_executed
  { id: "T15", from: "aus_executed", to: "preliminary_decision", actors: ["C", "S"] },
  { id: "T16", from: "aus_executed", to: "revision_requested", actors: ["C", "S"] },
  { id: "T17", from: "aus_executed", to: "withdrawn", actors: ["B"] },
  { id: "T18", from: "aus_executed", to: "suspended", actors: ["S"] },
  // preliminary_decision
  { id: "T19", from: "preliminary_decision", to: "approved", actors: ["S"] },
  { id: "T20", from: "preliminary_decision", to: "conditional_approval", actors: ["S"] },
  { id: "T21", from: "preliminary_decision", to: "escalated_review", actors: ["S"] },
  { id: "T22", from: "preliminary_decision", to: "denied", actors: ["S"] },
  { id: "T23", from: "preliminary_decision", to: "revision_requested", actors: ["S"] },
  { id: "T24", from: "preliminary_decision", to: "withdrawn", actors: ["B"] },
  { id: "T25", from: "preliminary_decision", to: "suspended", actors: ["S"] },
  // escalated_review
  { id: "T26", from: "escalated_review", to: "approved", actors: ["S"] },
  { id: "T26a", from: "escalated_review", to: "conditional_approval", actors: ["S"] },
  { id: "T26b", from: "escalated_review", to: "denied", actors: ["S"] },
  { id: "T26c", from: "escalated_review", to: "withdrawn", actors: ["B"] },
  { id: "T26d", from: "escalated_review", to: "suspended", actors: ["S"] },
  // conditional_approval
  { id: "T30", from: "conditional_approval", to: "approved", actors: ["C", "S"] },
  { id: "T31", from: "conditional_approval", to: "denied", actors: ["S"] },
  // §4.5.3: T32 = Declined by Borrower, T33 = Withdrawn (LENS-023 — the ids were
  // swapped here, so the immutable audit trail stamped a decline as T33 and a
  // withdrawal as T32, contradicting §4.5.3/WF-038/WF-039. Both edges behaved
  // correctly; only the recorded id was wrong. Historical rows carry the old ids.)
  { id: "T32", from: "conditional_approval", to: "declined_by_borrower", actors: ["B"] },
  { id: "T33", from: "conditional_approval", to: "withdrawn", actors: ["B"] },
  { id: "T34", from: "conditional_approval", to: "suspended", actors: ["S"] },
  // approved
  { id: "T27", from: "approved", to: "borrower_notified", actors: ["SYS"] },
  { id: "T29", from: "approved", to: "declined_by_borrower", actors: ["B"] },
  // denied
  { id: "T28", from: "denied", to: "borrower_notified", actors: ["SYS"] },
  // borrower_notified — T35 only when outcome=approved (caller applies the outcome guard)
  { id: "T35", from: "borrower_notified", to: "declined_by_borrower", actors: ["B"] },
  // revision_requested
  { id: "T36", from: "revision_requested", to: "completeness_validated", actors: ["B"] },
  { id: "T37", from: "revision_requested", to: "withdrawn", actors: ["B"] },
  // suspended — T38 resume returns exactly to previousStateForSuspend
  { id: "T38", from: "suspended", to: "application_received", actors: ["S"] },
  { id: "T38", from: "suspended", to: "completeness_validated", actors: ["S"] },
  { id: "T38", from: "suspended", to: "documents_received", actors: ["S"] },
  { id: "T38", from: "suspended", to: "aus_executed", actors: ["S"] },
  { id: "T38", from: "suspended", to: "preliminary_decision", actors: ["S"] },
  { id: "T38", from: "suspended", to: "escalated_review", actors: ["S"] },
  { id: "T38", from: "suspended", to: "conditional_approval", actors: ["S"] },
  { id: "T39", from: "suspended", to: "withdrawn", actors: ["B"] },
  { id: "T40", from: "suspended", to: "denied", actors: ["S"] },
  // withdrawn / declined_by_borrower — terminal (INV-033): no rows.
];

/** UserRole → transition-table actor letter. */
const ROLE_TO_ACTOR: Record<UserRole, TransitionActor> = {
  BORROWER: "B",
  CASEWORKER: "C",
  SUPERVISOR: "S",
};

/**
 * Application.availableTransitions: toState machine names valid for the current
 * state and caller role (contracts.md §A). Duplicate toStates collapse; order
 * follows the contract table. SYS-only transitions never appear for any role.
 */
export function availableTransitions(state: WorkflowState, role: UserRole): string[] {
  const actor = ROLE_TO_ACTOR[role];
  const out: string[] = [];
  for (const t of WORKFLOW_TRANSITIONS) {
    if (t.from !== state) continue;
    if (!t.actors.includes(actor)) continue;
    if (!out.includes(t.to)) out.push(t.to);
  }
  return out;
}

/** All toStates leaving `state` regardless of actor (ErrorResponse.allowedTransitions). */
export function allowedTransitionsFrom(state: WorkflowState): string[] {
  const out: string[] = [];
  for (const t of WORKFLOW_TRANSITIONS) {
    if (t.from !== state) continue;
    if (!out.includes(t.to)) out.push(t.to);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outcome-aware variants (INV-022 / INV-033, task-019)
// ---------------------------------------------------------------------------
//
// borrower_notified is bi-modal on Application.outcome and NOTHING else:
// outcome=approved permits exactly T35 (B); outcome=denied is terminal. These
// wrappers derive that behavior from outcome so no caller ever re-encodes it.

/** Outcome machine names (contracts.json enums.Outcome) — Prisma stores the same literals. */
type OutcomeValue = "approved" | "denied";

/** availableTransitions with the borrower_notified outcome guard applied (INV-022/INV-033). */
export function availableTransitionsForOutcome(
  state: WorkflowState,
  role: UserRole,
  outcome: OutcomeValue | null | undefined,
): string[] {
  if (state === "borrower_notified" && outcome !== "approved") return [];
  return availableTransitions(state, role);
}

/** allowedTransitionsFrom with the borrower_notified outcome guard applied (INV-022/INV-033). */
export function allowedTransitionsFromForOutcome(
  state: WorkflowState,
  outcome: OutcomeValue | null | undefined,
): string[] {
  if (state === "borrower_notified" && outcome !== "approved") return [];
  return allowedTransitionsFrom(state);
}

// ---------------------------------------------------------------------------
// State-class predicates (§4.5.1 columns)
// ---------------------------------------------------------------------------

/** §4.5.1 "Borrower-editable": section auto-save / co-borrower changes allowed. */
export const BORROWER_EDITABLE_STATES: readonly WorkflowState[] = ["draft", "revision_requested"];

export function isBorrowerEditableState(state: WorkflowState): boolean {
  return BORROWER_EDITABLE_STATES.includes(state);
}

/**
 * INV-016 active states — every state except draft and the terminal pair; matches
 * the DB partial unique index "Application_borrowerUserId_active_key" exactly.
 */
export const ACTIVE_STATES: readonly WorkflowState[] = [
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
  "approved",
  "denied",
  "borrower_notified",
  "revision_requested",
  "suspended",
];

export function isActiveState(state: WorkflowState): boolean {
  return ACTIVE_STATES.includes(state);
}

export const TERMINAL_STATES: readonly WorkflowState[] = ["withdrawn", "declined_by_borrower"];
