// Whitelist transition engine T1–T40 (task-019).
//
// Contracts: §A "Workflow State Transitions" (the exhaustive fixed table —
// src/lib/pure/workflow.ts holds it as data; this module EXECUTES it), §B
// "Transition endpoint semantics", XBR-001/002/005/006/007/008/010/011/012/013/
// 023, VR-078..082, INV-008/011/012/016/022/023/027/029/030/032/033/039, WF-047/
// WF-048, ASYNC-003.
//
// Design:
//   - The §A map (WORKFLOW_TRANSITIONS) is the single (from, to, actors)
//     authority; anything unlisted → 409 with currentState + allowedTransitions
//     (INV-033; borrower_notified derives terminality from outcome ONLY —
//     INV-022).
//   - Decision transitions (T19–T22, T26/T26a/T26b, T31, T40) are gate-only:
//     rejected here 409 directing to POST /api/applications/:id/approval-decision.
//   - T27/T28 are SYS-only: rejected 409 for EVERY HTTP caller; they execute
//     exclusively through executeDecisionDispatch (decision-dispatch.ts).
//   - Every transition: state + stateEnteredAt + versionStamp(+1, stale → 409,
//     race decided by the versionStamp WHERE clause) + WorkflowHistory row +
//     audit entry in ONE prisma.$transaction, all-or-nothing (XBR-013).
//   - T1/T36 compose the submission substance (submitApplicationInTx) inside the
//     engine's transaction and layer the XBR-001/XBR-012 effects on top.
//   - Notifications route through THE notification service (task-036,
//     src/lib/services/notifications.ts — §4.8.1 single-service mandate):
//     in-app row in this transaction; external email/SMS per borrower
//     preference handled by the service (ASYNC-002, post-commit).

import type { Prisma, UserRole, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import {
  APPLICATION_INCLUDE,
  serializeApplication,
  type ApplicationWithRelations,
} from "@/lib/services/application-serializer";
import { resolveSubmissionUniqueViolation, submitApplicationInTx } from "@/lib/services/submission";
import { withSlaFields, type SlaEnrichableRow } from "@/lib/services/sla";
import { persistApplicationQualification } from "@/lib/services/qualification";
import { executeDecisionDispatch } from "@/lib/services/decision-dispatch";
import { evaluateApplicationChecklist } from "@/lib/services/document";
import { isChecklistGateSatisfied } from "@/lib/pure/checklist";
import {
  WORKFLOW_TRANSITIONS,
  TERMINAL_STATES,
  allowedTransitionsFromForOutcome,
  workflowStateLabel,
  type WorkflowTransition,
} from "@/lib/pure/workflow";
import type { TransitionRequestBody } from "@/lib/schemas/transition";

// ---------------------------------------------------------------------------
// Transition classes (ids verbatim from the §A table)
// ---------------------------------------------------------------------------

/** Gate-only decision transitions — execute exclusively via the approval-decision endpoint. */
const DECISION_GATE_IDS = new Set(["T19", "T20", "T21", "T22", "T26", "T26a", "T26b", "T31", "T40"]);
/** SYS-only transitions — execute exclusively via executeDecisionDispatch (ASYNC-003). */
const SYS_IDS = new Set(["T27", "T28"]);
/** Transitions to revision_requested — formal note required (VR-080, XBR-005). */
const REVISION_IDS = new Set(["T4", "T8", "T12", "T16", "T23"]);
/** Suspend transitions — reason required (VR-081), previousStateForSuspend + slaPausedAt set (INV-032). */
const SUSPEND_IDS = new Set(["T6", "T10", "T14", "T18", "T25", "T26d", "T34"]);
/** Borrower withdraw/decline transitions (reason optional per TransitionRequest.reason). */
// Borrower withdraw (T2/T5/T9/T13/T17/T24/T26c/T33/T37/T39) + decline
// (T29/T32/T35) transitions. LENS-023: T32 (decline) was missing here while the
// swapped-id table had T33 in its place; with §4.5.3 ids corrected BOTH
// conditional_approval borrower exits (T32 decline, T33 withdraw) belong in the set.
const WITHDRAW_IDS = new Set(["T2", "T5", "T9", "T13", "T17", "T24", "T26c", "T29", "T32", "T33", "T35", "T37", "T39"]);

const UNDERWRITING_CHECK_TYPES = ["credit", "income", "avm", "pricing"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EngineApplication {
  id: string;
  applicationNumber: string;
  borrowerUserId: string;
  workflowState: WorkflowState;
  previousStateForSuspend: WorkflowState | null;
  versionStamp: number;
  outcome: "approved" | "denied" | null;
  currentVersionNumber: number;
  decidedAt: Date | null;
  ausStale: boolean;
  /** Caseworker user id of the current ACTIVE assignment, or null. */
  activeCaseworkerUserId: string | null;
}

function workflowConflict(message: string, app: EngineApplication): HttpProblem {
  return new HttpProblem(409, ERROR_CODES.conflict, message, {
    currentState: app.workflowState,
    allowedTransitions: allowedTransitionsFromForOutcome(app.workflowState, app.outcome),
  });
}

function staleStampConflict(): HttpProblem {
  return new HttpProblem(
    409,
    ERROR_CODES.conflict,
    "This application was changed in another tab or session — reload and try again",
  );
}

function bodyValidationError(details: string[]): HttpProblem {
  return new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", { details });
}

async function loadEngineApplication(applicationId: string): Promise<EngineApplication | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      applicationNumber: true,
      borrowerUserId: true,
      workflowState: true,
      previousStateForSuspend: true,
      versionStamp: true,
      outcome: true,
      currentVersionNumber: true,
      decidedAt: true,
      ausStale: true,
      assignments: { where: { endedAt: null }, select: { caseworkerUserId: true }, take: 1 },
    },
  });
  if (!app) return null;
  return {
    id: app.id,
    applicationNumber: app.applicationNumber,
    borrowerUserId: app.borrowerUserId,
    workflowState: app.workflowState,
    previousStateForSuspend: app.previousStateForSuspend,
    versionStamp: app.versionStamp,
    outcome: app.outcome,
    currentVersionNumber: app.currentVersionNumber,
    decidedAt: app.decidedAt,
    ausStale: app.ausStale,
    activeCaseworkerUserId: app.assignments[0]?.caseworkerUserId ?? null,
  };
}

/**
 * XBR-005/XBR-012: mark every underwriting result stale (revision loop / T36
 * resubmission); ausStale mirrors on the application when a completed AUS
 * result exists (nothing to re-run otherwise).
 */
async function markUnderwritingStale(tx: Prisma.TransactionClient, applicationId: string): Promise<void> {
  await tx.underwritingResult.updateMany({
    where: { applicationId, isStale: false },
    data: { isStale: true },
  });
  // §E / ASM-006: marking every result stale includes any AVM result, which
  // stops being "available" — the stored ltv/cltv revert to the
  // estimatedValue-only basis via THE shared module, atomic with the marks.
  await persistApplicationQualification(applicationId, tx);
  const completedAus = await tx.underwritingResult.count({
    where: { applicationId, checkType: "aus", status: "completed" },
  });
  if (completedAus > 0) {
    await tx.application.update({ where: { id: applicationId }, data: { ausStale: true } });
  }
}

/**
 * Notification row in-tx, routed through THE notification service (task-036,
 * §4.8.1 single-service mandate — borrower recipients additionally get the
 * external email/SMS dispatch per preference inside the service).
 */
async function notifyInTx(
  tx: Prisma.TransactionClient,
  recipientUserId: string,
  type: string,
  title: string,
  body: string,
  applicationId: string,
): Promise<void> {
  await createNotification(tx, { recipientUserId, type, title, body, applicationId });
}

async function activeSupervisorIds(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.user.findMany({
    where: { role: "SUPERVISOR", status: "active" },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Preconditions (live in-tx reads — TOCTOU-safe alongside the stamp guard)
// ---------------------------------------------------------------------------

async function currentCheckResult(
  tx: Prisma.TransactionClient,
  applicationId: string,
  checkType: "credit" | "income" | "avm" | "pricing" | "aus",
) {
  return tx.underwritingResult.findFirst({
    where: { applicationId, checkType, supersededById: null },
    orderBy: { requestedAt: "desc" },
    select: { status: true, error: true, isStale: true },
  });
}

async function assertPreconditions(
  tx: Prisma.TransactionClient,
  app: EngineApplication,
  transition: WorkflowTransition,
): Promise<void> {
  switch (transition.id) {
    case "T7": {
      // XBR-006: every required checklist item Accepted/Waived.
      const items = await evaluateApplicationChecklist(tx, app.id);
      if (!isChecklistGateSatisfied(items)) {
        const outstanding = items
          .filter((item) => item.required && !isChecklistGateSatisfied([item]))
          .map((item) => item.label);
        throw workflowConflict(
          `Every required checklist item must be Accepted or Waived before marking documents received (outstanding: ${outstanding.join(", ")})`,
          app,
        );
      }
      return;
    }
    case "T11": {
      // XBR-007 / INV-030: credit, income, AVM, pricing all completed,
      // non-errored, non-stale; AUS result recorded.
      for (const checkType of UNDERWRITING_CHECK_TYPES) {
        const result = await currentCheckResult(tx, app.id, checkType);
        if (!result || result.status !== "completed" || result.error || result.isStale) {
          throw workflowConflict(
            `The ${checkType} check must be completed, error-free, and current before AUS execution`,
            app,
          );
        }
      }
      const aus = await currentCheckResult(tx, app.id, "aus");
      if (!aus || aus.status !== "completed" || aus.error) {
        throw workflowConflict("An AUS result must be recorded before entering AUS Executed", app);
      }
      return;
    }
    case "T15": {
      // XBR-008 / INV-030: AUS non-stale; no open high-severity fraud flag.
      const aus = await currentCheckResult(tx, app.id, "aus");
      if (!aus || aus.status !== "completed" || aus.error) {
        throw workflowConflict("An AUS result is required before recording a preliminary decision", app);
      }
      if (aus.isStale || app.ausStale) {
        throw workflowConflict("The AUS result is stale — re-run AUS before the preliminary decision", app);
      }
      const openHighFlags = await tx.fraudFlag.count({
        where: { applicationId: app.id, status: "open", severity: "high" },
      });
      if (openHighFlags > 0) {
        throw workflowConflict(
          "Open high-severity fraud flags must be resolved or dismissed before a preliminary decision",
          app,
        );
      }
      return;
    }
    case "T30": {
      // XBR-011: EVERY Condition on the application — across all
      // ApprovalRecords, not only the most recent approving record — must be
      // cleared. A file can carry conditions bound to more than one record
      // (successive conditional decisions), and a per-record count would let a
      // fully approved loan close with another record's condition still open.
      const approvingRecord = await tx.approvalRecord.findFirst({
        where: { applicationId: app.id, decision: "approve" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!approvingRecord) {
        throw workflowConflict("No approving approval record exists for this conditional approval", app);
      }
      const openConditions = await tx.condition.count({
        where: { applicationId: app.id, status: "open" },
      });
      if (openConditions > 0) {
        throw workflowConflict(
          `Every condition must be cleared before final approval (${openConditions} still open)`,
          app,
        );
      }
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Per-transition notification effects (§A annotations + XBR-005/007)
// ---------------------------------------------------------------------------

async function createTransitionNotifications(
  tx: Prisma.TransactionClient,
  app: EngineApplication,
  transition: WorkflowTransition,
): Promise<void> {
  const n = app.applicationNumber;

  if (transition.id === "T3") {
    // §A: notify B.
    await notifyInTx(
      tx,
      app.borrowerUserId,
      "workflow-transition",
      "Application validated",
      `Your application ${n} passed completeness and consistency validation.`,
      app.id,
    );
    return;
  }

  if (REVISION_IDS.has(transition.id)) {
    // XBR-005: notify the Borrower; the formal note carries the details.
    await notifyInTx(
      tx,
      app.borrowerUserId,
      "revision-requested",
      "Revisions requested",
      `Your loan team requested revisions to application ${n}. See the formal note for what to update.`,
      app.id,
    );
    return;
  }

  if (transition.id === "T11") {
    // XBR-007: notify caseworker and supervisors.
    if (app.activeCaseworkerUserId) {
      await notifyInTx(
        tx,
        app.activeCaseworkerUserId,
        "aus-executed",
        "AUS executed",
        `AUS has been executed for application ${n}.`,
        app.id,
      );
    }
    for (const supervisorId of await activeSupervisorIds(tx)) {
      await notifyInTx(
        tx,
        supervisorId,
        "aus-executed",
        "AUS executed",
        `AUS has been executed for application ${n}.`,
        app.id,
      );
    }
    return;
  }

  if (transition.id === "T15") {
    // §4.8.2 supervisor trigger "pending Level-1 approval": entering
    // Preliminary Decision puts the file in front of the approval gate.
    for (const supervisorId of await activeSupervisorIds(tx)) {
      await notifyInTx(
        tx,
        supervisorId,
        "pending-level-1",
        "Pending Level-1 approval",
        `Application ${n} reached Preliminary Decision and awaits a Level-1 approval decision.`,
        app.id,
      );
    }
    return;
  }

  if (transition.to === "withdrawn") {
    // §4.8.2: borrower withdrawal confirmation + caseworker notification —
    // EVERY withdraw transition (T2/T5/T9/T13/T17/T24/T26c/T33/T37/T39). Routed by
    // transition.to, so swap-safe; the id list is documentation (LENS-023: T33 is
    // the conditional_approval withdrawal, T32 is its decline).
    await notifyInTx(
      tx,
      app.borrowerUserId,
      "withdrawal-confirmation",
      "Withdrawal confirmed",
      `Your application ${n} has been withdrawn. This is a confirmation — no further action is needed.`,
      app.id,
    );
    if (app.activeCaseworkerUserId) {
      await notifyInTx(
        tx,
        app.activeCaseworkerUserId,
        "application-withdrawn",
        "Application withdrawn",
        `The borrower withdrew application ${n}.`,
        app.id,
      );
    }
    return;
  }

  if (transition.to === "declined_by_borrower") {
    // §4.8.2: borrower decline confirmation + caseworker notification
    // (T29/T32/T35). Routed by transition.to (swap-safe); LENS-023: T32 is the
    // conditional_approval decline.
    await notifyInTx(
      tx,
      app.borrowerUserId,
      "decline-confirmation",
      "Decline confirmed",
      `You declined the approved offer on application ${n}. This is a confirmation of that decision.`,
      app.id,
    );
    if (app.activeCaseworkerUserId) {
      await notifyInTx(
        tx,
        app.activeCaseworkerUserId,
        "application-declined",
        "Offer declined by borrower",
        `The borrower declined the approved offer on application ${n}.`,
        app.id,
      );
    }
    return;
  }

  if (SUSPEND_IDS.has(transition.id)) {
    if (app.activeCaseworkerUserId) {
      await notifyInTx(
        tx,
        app.activeCaseworkerUserId,
        "application-suspended",
        "Application suspended",
        `Application ${n} was suspended by a supervisor. The SLA clock is paused.`,
        app.id,
      );
    }
    return;
  }

  if (transition.id === "T38") {
    if (app.activeCaseworkerUserId) {
      await notifyInTx(
        tx,
        app.activeCaseworkerUserId,
        "application-resumed",
        "Application resumed",
        `Application ${n} was resumed to ${workflowStateLabel(transition.to)}. The SLA clock is running again.`,
        app.id,
      );
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Execute one whitelist transition for the authenticated caller. Throws
 * HttpProblem for every contract failure (403/404/409/400); returns the
 * serialized §A Application on success. `user` MUST come from the session
 * (audit integrity — actor identity is never read from the body).
 */
export async function executeTransition(
  user: SessionUser,
  applicationId: string,
  body: TransitionRequestBody,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const app = await loadEngineApplication(applicationId);
  if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

  // RECORD-LEVEL SCOPING: a borrower may only ever act on their own application
  // — and never learns another borrower's application exists (404, not 403).
  if (user.role === "BORROWER" && app.borrowerUserId !== user.userId) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  }

  // ------------------------------------------------------------------
  // 1. Whitelist match (INV-033): unlisted (from, to) → 409 with
  //    currentState + allowedTransitions. borrower_notified terminality
  //    derives from outcome ONLY (INV-022).
  // ------------------------------------------------------------------
  const toState = body.toState as WorkflowState;
  const transition = WORKFLOW_TRANSITIONS.find(
    (t) => t.from === app.workflowState && t.to === toState,
  );
  const notifiedTerminal = app.workflowState === "borrower_notified" && app.outcome !== "approved";

  if (!transition || notifiedTerminal) {
    const stateLabel = workflowStateLabel(app.workflowState);
    if (TERMINAL_STATES.includes(app.workflowState) || notifiedTerminal) {
      throw workflowConflict(`${stateLabel} is a terminal state — no transitions are available`, app);
    }
    throw workflowConflict(
      `No transition from ${stateLabel} to ${workflowStateLabel(toState)} is available`,
      app,
    );
  }

  // ------------------------------------------------------------------
  // 2. Routing exclusions (§B transition-endpoint semantics).
  // ------------------------------------------------------------------
  if (DECISION_GATE_IDS.has(transition.id)) {
    throw workflowConflict(
      "Decision transitions execute through the approval gate — use POST /api/applications/:id/approval-decision",
      app,
    );
  }
  if (SYS_IDS.has(transition.id)) {
    throw workflowConflict(
      "This transition is performed automatically by the system when the decision notification is dispatched",
      app,
    );
  }

  // ------------------------------------------------------------------
  // 3. Actor rules (§A actor letters; INV-026/INV-027).
  // ------------------------------------------------------------------
  const actor = user.role === "BORROWER" ? "B" : user.role === "CASEWORKER" ? "C" : "S";
  if (!transition.actors.includes(actor)) {
    if (transition.actors.length === 1 && transition.actors[0] === "B") {
      // INV-027: borrower-only lifecycle actions — staff INCLUDING supervisors rejected.
      throw new HttpProblem(
        403,
        ERROR_CODES.forbidden,
        "Only the borrower who owns this application may perform this action",
      );
    }
    throw new HttpProblem(
      403,
      ERROR_CODES.forbidden,
      "Your role cannot perform this transition",
    );
  }
  if (actor === "C" && app.activeCaseworkerUserId !== user.userId) {
    // S-3: caseworker transitions require the current ACTIVE assignment.
    throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
  }

  // ------------------------------------------------------------------
  // 4. Cross-field body requirements (VR-080/081/082) → 400.
  // ------------------------------------------------------------------
  const details: string[] = [];
  if (REVISION_IDS.has(transition.id) && !body.note?.trim()) {
    details.push("note: a formal note is required for a revision request");
  }
  if (SUSPEND_IDS.has(transition.id) && !body.reason?.trim()) {
    details.push("reason: a reason is required to suspend an application");
  }
  if (transition.id === "T15") {
    if (!body.recommendation) {
      details.push("recommendation: a preliminary recommendation (approve / approve-with-conditions / deny) is required");
    }
    if (!body.note?.trim()) {
      details.push("note: a formal note draft is required with the preliminary recommendation");
    }
  }
  if (details.length > 0) throw bodyValidationError(details);

  // ------------------------------------------------------------------
  // 5. T38: resume must return EXACTLY to previousStateForSuspend (INV-032).
  // ------------------------------------------------------------------
  if (transition.id === "T38" && toState !== app.previousStateForSuspend) {
    throw workflowConflict(
      app.previousStateForSuspend
        ? `Resume must return exactly to ${workflowStateLabel(app.previousStateForSuspend)}`
        : "This suspended application has no recorded prior state to resume to",
      app,
    );
  }

  // ------------------------------------------------------------------
  // 6. Optimistic concurrency (INV-039): early check for a clean 409; the
  //    versionStamp WHERE clause inside the transaction decides races.
  // ------------------------------------------------------------------
  if (app.versionStamp !== body.versionStamp) throw staleStampConflict();

  // ------------------------------------------------------------------
  // 7. Execute.
  // ------------------------------------------------------------------
  if (transition.id === "T1" || transition.id === "T36") {
    await executeSubmissionTransition(user, app, transition, body, meta);
  } else {
    await executeGenericTransition(user, app, transition, body, meta);
  }

  // T30 triggers SYS T27 via the decision-dispatch path (§B semantics,
  // ASYNC-003 multi-tx): dispatch failure leaves the application in Approved
  // with decisionNotificationPending=true — never an error to the caller.
  if (transition.id === "T30") {
    try {
      await executeDecisionDispatch(app.id, { requestId: meta.requestId });
    } catch (err) {
      // A concurrent-write conflict here means someone else advanced the file
      // between our commit and the dispatch — the retry path (task-036) owns it.
      if (!(err instanceof HttpProblem)) throw err;
    }
  }

  const row = await prisma.application.findUnique({
    where: { id: app.id },
    include: APPLICATION_INCLUDE,
  });
  if (!row) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  // task-021: transition responses carry live slaStatus / overallSlaDaysRemaining.
  return withSlaFields(
    serializeApplication(row as ApplicationWithRelations, user.role),
    row as unknown as SlaEnrichableRow,
  );
}

/**
 * T1/T36: the submission substance (validation gate, INV-016 one-active,
 * INV-008 snapshot, INV-011 revisionCycles, INV-029 signatures, stamp, history,
 * audit) via submitApplicationInTx, plus the engine-owned effects: XBR-001 (T1
 * notifies Borrower + all Supervisors), XBR-012 (T36 marks underwriting stale +
 * notifies the caseworker) — all in ONE transaction.
 */
async function executeSubmissionTransition(
  user: SessionUser,
  app: EngineApplication,
  transition: WorkflowTransition,
  body: TransitionRequestBody,
  meta: RequestMetaBundle,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const core = await submitApplicationInTx(tx, user.userId, app.id, body.versionStamp, {
        ip: meta.ip,
        requestId: meta.requestId,
        actorRole: "BORROWER",
      });

      if (transition.id === "T1") {
        // XBR-001: notify the Borrower and all Supervisors in the same operation.
        await notifyInTx(
          tx,
          app.borrowerUserId,
          "application-submitted",
          "Application submitted",
          `Your application ${core.applicationNumber} was submitted and is now in underwriting (Version ${core.versionNumber}).`,
          app.id,
        );
        for (const supervisorId of await activeSupervisorIds(tx)) {
          await notifyInTx(
            tx,
            supervisorId,
            "application-submitted",
            "New application submitted",
            `Application ${core.applicationNumber} was submitted and is awaiting assignment.`,
            app.id,
          );
        }
      } else {
        // XBR-012: resubmission marks underwriting results stale and notifies
        // the caseworker; priors (versions/corrections/documents) are retained
        // by construction — nothing is deleted anywhere in this path.
        await markUnderwritingStale(tx, app.id);
        if (app.activeCaseworkerUserId) {
          await notifyInTx(
            tx,
            app.activeCaseworkerUserId,
            "application-resubmitted",
            "Application resubmitted",
            `Application ${core.applicationNumber} was resubmitted (Version ${core.versionNumber}, revision cycle ${core.revisionCycles}).`,
            app.id,
          );
        }
      }
    });
  } catch (err) {
    const mapped = await resolveSubmissionUniqueViolation(err, user.userId, app.id);
    if (mapped) throw mapped;
    throw err;
  }
}

/**
 * Every non-submission, non-gate, non-SYS transition: preconditions (live
 * in-tx reads), stamped state write, WorkflowHistory + audit + per-transition
 * side effects, all-or-nothing.
 */
async function executeGenericTransition(
  user: SessionUser,
  app: EngineApplication,
  transition: WorkflowTransition,
  body: TransitionRequestBody,
  meta: RequestMetaBundle,
): Promise<void> {
  const toState = transition.to;
  const now = new Date();

  // WorkflowHistoryInfo.note content: suspend → reason; withdraw/decline →
  // optional reason (falling back to note); T15 → none here (the formal-note
  // draft is staff-internal until the decision — see below); else → optional note.
  const historyNote = SUSPEND_IDS.has(transition.id)
    ? body.reason!.trim()
    : WITHDRAW_IDS.has(transition.id)
      ? body.reason?.trim() || body.note?.trim() || null
      : transition.id === "T15"
        ? null
        : body.note?.trim() || null;

  await prisma.$transaction(async (tx) => {
    await assertPreconditions(tx, app, transition);

    const data: Prisma.ApplicationUpdateManyMutationInput = {
      workflowState: toState,
      stateEnteredAt: now,
      versionStamp: { increment: 1 },
    };
    if (SUSPEND_IDS.has(transition.id)) {
      // INV-032 / XBR-023: previousStateForSuspend always set; SLA paused.
      data.previousStateForSuspend = app.workflowState;
      data.slaPausedAt = now;
    }
    if (transition.id === "T38") {
      // XBR-023: resume clears the marker and restarts the clock; the
      // suspend/resume WorkflowHistory rows are the interval source (task-021
      // excludes each interval exactly once from SLA elapsed — INV-012).
      data.previousStateForSuspend = null;
      data.slaPausedAt = null;
    }
    if (transition.id === "T15") {
      data.preliminaryRecommendation = body.recommendation;
    }
    if (transition.id === "T30" && !app.decidedAt) {
      data.decidedAt = now;
    }

    // CHECK-THEN-ACT GUARD: the stamp in the WHERE clause decides races.
    const updated = await tx.application.updateMany({
      where: { id: app.id, versionStamp: body.versionStamp },
      data,
    });
    if (updated.count === 0) throw staleStampConflict();

    // XBR-013: one WorkflowHistory row per transition, in-tx.
    const history = await tx.workflowHistory.create({
      data: {
        applicationId: app.id,
        fromState: app.workflowState,
        toState,
        actorUserId: user.userId,
        actorRole: user.role,
        note: historyNote,
        versionNumber: app.currentVersionNumber > 0 ? app.currentVersionNumber : null,
      },
    });

    if (REVISION_IDS.has(transition.id)) {
      // WF-048/XBR-005: the required note becomes a formal ApplicationNote
      // attached to this transition; underwriting results go stale for the loop.
      await tx.applicationNote.create({
        data: {
          applicationId: app.id,
          authorUserId: user.userId,
          type: "formal",
          content: body.note!.trim(),
          relatedTransitionId: history.id,
        },
      });
      await markUnderwritingStale(tx, app.id);
    }

    if (transition.id === "T15") {
      // VR-082: the formal note DRAFT recorded with the recommendation. Stored
      // as an INTERNAL note (staff-only) attached to the T15 transition: it is
      // a draft of the eventual decision note — S-7 keeps pre-decision staff
      // work product away from borrower surfaces; the approval panel (task-032)
      // reads it plus Application.preliminaryRecommendation.
      await tx.applicationNote.create({
        data: {
          applicationId: app.id,
          authorUserId: user.userId,
          type: "internal",
          content: body.note!.trim(),
          relatedTransitionId: history.id,
        },
      });
    }

    // XBR-013: one AuditLogEntry per transition, same transaction — a failed
    // audit write rolls the state change back.
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "workflow-transition",
      applicationId: app.id,
      entityType: "Application",
      entityId: app.id,
      summary: `${transition.id}: ${workflowStateLabel(app.workflowState)} → ${workflowStateLabel(toState)}`,
      reason: body.reason?.trim() || null,
      ip: meta.ip,
      requestId: meta.requestId,
    });

    await createTransitionNotifications(tx, app, transition);
  });
}

// ---------------------------------------------------------------------------
// Gate-performed decision transitions (task-020 — the ONLY sanctioned caller)
// ---------------------------------------------------------------------------

/** Input for one gate-performed decision transition (T19–T26b, T31, T40). */
export interface DecisionTransitionInput {
  applicationId: string;
  fromState: WorkflowState;
  toState: WorkflowState;
  /** §A transition id (T19, T20, T21, T22, T26, T26a, T26b, T31, T40). */
  transitionId: string;
  /** Stamp echoed by the caller — the WHERE clause decides races (INV-039). */
  expectedVersionStamp: number;
  /** ApplicationVersion.versionNumber decided (0 never occurs post-submission). */
  currentVersionNumber: number;
  /** From the authenticated session ONLY (audit integrity). */
  actorUserId: string;
  actorRole: UserRole;
  /** WorkflowHistoryInfo.note content, when any. */
  note?: string | null;
  /**
   * Additional Application column updates committed atomically with the state
   * write (escalationRequired/escalationCriteriaMet, decidedAt, INV-032
   * previousStateForSuspend clearing on T40, ...).
   */
  data?: Prisma.ApplicationUpdateManyMutationInput;
  meta: RequestMetaBundle;
}

/**
 * The engine's transactional transition core, exported for the approval gate
 * (task-020) so decision transitions reuse EXACTLY the same machinery instead
 * of re-implementing it: stamped state write (stale/raced → 409 via the
 * versionStamp WHERE clause), WorkflowHistory row, and workflow-transition
 * audit entry — all on the CALLER's open transaction, so the ApprovalRecord
 * write and the transition commit or roll back together (XBR-013 +
 * ADMIN-ENDPOINT INVARIANT RULE: no state assignment outside this path).
 *
 * Deliberately NOT wired to the HTTP transition endpoint: decision toStates
 * remain gate-only there (DECISION_GATE_IDS above).
 */
export async function applyDecisionTransitionInTx(
  tx: Prisma.TransactionClient,
  input: DecisionTransitionInput,
): Promise<{ historyId: string }> {
  const now = new Date();

  const updated = await tx.application.updateMany({
    where: { id: input.applicationId, versionStamp: input.expectedVersionStamp },
    data: {
      workflowState: input.toState,
      stateEnteredAt: now,
      versionStamp: { increment: 1 },
      ...(input.data ?? {}),
    },
  });
  if (updated.count === 0) throw staleStampConflict();

  // XBR-013: one WorkflowHistory row per transition, in-tx.
  const history = await tx.workflowHistory.create({
    data: {
      applicationId: input.applicationId,
      fromState: input.fromState,
      toState: input.toState,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      note: input.note?.trim() || null,
      versionNumber: input.currentVersionNumber > 0 ? input.currentVersionNumber : null,
    },
  });

  // XBR-013: one AuditLogEntry per transition, same transaction.
  await audit(tx, {
    actor: input.actorUserId,
    role: input.actorRole,
    actionType: "workflow-transition",
    applicationId: input.applicationId,
    entityType: "Application",
    entityId: input.applicationId,
    summary: `${input.transitionId}: ${workflowStateLabel(input.fromState)} → ${workflowStateLabel(input.toState)}`,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
  });

  return { historyId: history.id };
}
