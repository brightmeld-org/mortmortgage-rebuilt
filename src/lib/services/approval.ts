// Approval gate, escalation, and decision transitions (task-020).
//
// Contracts: §4.5.2 approval model (WF-002), §A ApprovalRecordInfo /
// ConditionInfo / ApprovalDecisionRequest, §B approval-decision + approvals +
// conditions/:id/clear endpoint rows and "Transition endpoint semantics"
// (decision transitions T19–T26b, T31, T40 execute EXCLUSIVELY here), §D
// XBR-009/010/011, §E VR-083..088 (schema: src/lib/schemas/approval.ts), §F
// INV-001/017/020/021/022/028, §G ASYNC-003, AMB-010, ASM-006, AC-31/AC-32.
//
// Design:
//   - Level is DERIVED from the current workflow state (the request carries no
//     level field): preliminary_decision → Level 1; escalated_review → Level 2
//     (approver ≠ L1 approver, INV-001); conditional_approval (T31) and
//     suspended (T40) accept ONLY deny, recorded at the highest previously
//     required level (2 iff an escalated L1 exists for this version).
//   - Escalation criteria (LTV > threshold, DTI > threshold, loan type in the
//     two-level set — ALL live from SystemConfig, AC-32) are evaluated at the
//     Level-1 decision moment with current DTI/LTV from the single shared
//     qualification module (AC-13; ASM-006 stale-AVM fallback lives in its pure
//     core) and recorded on the ApprovalRecord (criteriaEvaluated +
//     dtiAtDecision/ltvAtDecision, XBR-009).
//   - The ApprovalRecord write AND the resulting workflow transition execute in
//     ONE prisma.$transaction via the engine's exported
//     applyDecisionTransitionInTx (stamped write + WorkflowHistory + audit) —
//     a loser of any race rolls back its record with its transition.
//   - INV-017 concurrency: the partial unique indexes on ApprovalRecord
//     (applicationId, versionNumber, level) per decision value are the race
//     authority — P2002 maps to the contracted 409. (See the
//     approval_decision_partial_unique migration for the INV-017 × WF-037/
//     WF-046 reconciliation: T31/T40 write a deny at a level that already
//     holds the approve which produced conditional_approval.)
//   - INV-028: the gate into approved/conditional_approval verifies an approve
//     at EVERY required level and treats any deny record at a required level as
//     permanently disqualifying — a deny never satisfies a level.
//   - On approved/denied outcomes the gate calls executeDecisionDispatch
//     post-commit (ASYNC-003): dispatch failure leaves the application in
//     approved/denied with decisionNotificationPending=true — surfaced on the
//     response, never an error to the caller.
//   - Notifications route through THE notification service (task-036,
//     src/lib/services/notifications.ts — §4.8.1 single-service mandate).
//
// Server-side only — never import from client components.

import { Prisma } from "@prisma/client";
import type { ApprovalRecord, Condition, WorkflowState } from "@prisma/client";
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
import { withSlaFields, type SlaEnrichableRow } from "@/lib/services/sla";
import { applyDecisionTransitionInTx } from "@/lib/services/workflow-engine";
import { executeDecisionDispatch } from "@/lib/services/decision-dispatch";
import { computeApplicationQualification } from "@/lib/services/qualification";
import { getNumberSetting, getStringListSetting } from "@/lib/services/config";
import { canReadApplication } from "@/lib/guard";
import { allowedTransitionsFromForOutcome, workflowStateLabel } from "@/lib/pure/workflow";
import type { ApprovalDecisionRequestBody } from "@/lib/schemas/approval";

// ---------------------------------------------------------------------------
// Shared problems
// ---------------------------------------------------------------------------

function notFoundProblem(message: string): HttpProblem {
  return new HttpProblem(404, ERROR_CODES.notFound, message);
}

function forbiddenProblem(message: string): HttpProblem {
  return new HttpProblem(403, ERROR_CODES.forbidden, message);
}

function staleStampConflict(): HttpProblem {
  return new HttpProblem(
    409,
    ERROR_CODES.conflict,
    "This application was changed in another tab or session — reload and try again",
  );
}

interface WorkflowConflictSlice {
  workflowState: WorkflowState;
  outcome: "approved" | "denied" | null;
}

function workflowConflict(message: string, app: WorkflowConflictSlice): HttpProblem {
  return new HttpProblem(409, ERROR_CODES.conflict, message, {
    currentState: app.workflowState,
    allowedTransitions: allowedTransitionsFromForOutcome(app.workflowState, app.outcome),
  });
}

/** INV-017: unique-index violation on ApprovalRecord → the contracted concurrency 409. */
function isApprovalRecordUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// INV-020: live approver check (role + status at decision time)
// ---------------------------------------------------------------------------

async function assertActiveSupervisor(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true },
  });
  if (!row || row.role !== "SUPERVISOR") {
    // Caseworkers (and any non-supervisor) never record approval decisions.
    throw forbiddenProblem("Only a Supervisor may record approval decisions");
  }
  if (row.status !== "active") {
    throw forbiddenProblem("Your account is not active — approval decisions require an active Supervisor account");
  }
}

// ---------------------------------------------------------------------------
// Escalation evaluation (XBR-009, AC-32) — live config, live DTI/LTV
// ---------------------------------------------------------------------------

export interface EscalationEvaluation {
  /** True when ANY configured criterion is met → two-level review required. */
  required: boolean;
  /** Human-readable labels of the criteria that were MET (Application.escalationCriteriaMet). */
  metLabels: string[];
  /** Human-readable labels of EVERY criterion evaluated (ApprovalRecord.criteriaEvaluated). */
  evaluatedLabels: string[];
  /** Current DTI percent at the decision moment (shared module, AC-13). */
  dti: number | null;
  /** Current LTV percent at the decision moment (non-stale AVM only, ASM-006). */
  ltv: number | null;
}

/**
 * Evaluate the §4.5.2 escalation criteria at the Level-1 decision moment.
 * Thresholds and the two-level loan-type set are read from SystemConfig at
 * call time (the config service invalidates its cache on every write, so a
 * threshold change flips behavior on the next decision — AC-32). DTI/LTV come
 * from the single shared qualification service (AC-13); its pure core encodes
 * ASM-006 (a stale AVM result is NOT available — LTV falls back to the stated
 * estimated value).
 *
 * Exported (task-025): the §4.6.5 qualification summary card serves the SAME
 * live evaluation — one implementation for gate and card.
 */
export async function evaluateEscalation(
  tx: Prisma.TransactionClient,
  applicationId: string,
): Promise<EscalationEvaluation> {
  const qualification = await computeApplicationQualification(applicationId, tx);
  const [ltvThreshold, dtiThreshold, twoLevelLoanTypes] = await Promise.all([
    getNumberSetting("escalation.ltvThresholdPercent"),
    getNumberSetting("escalation.dtiThresholdPercent"),
    getStringListSetting("approval.twoLevelLoanTypes"),
  ]);

  const data = await tx.applicationData.findUnique({
    where: { applicationId },
    select: { loan: true },
  });
  const loan =
    data?.loan && typeof data.loan === "object" && !Array.isArray(data.loan)
      ? (data.loan as Record<string, unknown>)
      : null;
  const loanType = typeof loan?.loanType === "string" ? loan.loanType : null;

  const { dti, ltv } = qualification;

  const ltvMet = ltv !== null && ltv > ltvThreshold;
  const dtiMet = dti !== null && dti > dtiThreshold;
  const loanTypeMet = loanType !== null && twoLevelLoanTypes.includes(loanType);

  const ltvLabel = ltv === null ? `LTV unavailable (threshold ${ltvThreshold}%)` : `LTV ${ltv}% > ${ltvThreshold}%`;
  const dtiLabel = dti === null ? `DTI unavailable (threshold ${dtiThreshold}%)` : `DTI ${dti}% > ${dtiThreshold}%`;
  const loanTypeLabel =
    loanType === null
      ? `Loan type unavailable (two-level set: ${twoLevelLoanTypes.join(", ")})`
      : `Loan type ${loanType} in two-level set (${twoLevelLoanTypes.join(", ")})`;

  const metLabels: string[] = [];
  if (ltvMet) metLabels.push(ltvLabel);
  if (dtiMet) metLabels.push(dtiLabel);
  if (loanTypeMet) metLabels.push(loanTypeLabel);

  return {
    required: metLabels.length > 0,
    metLabels,
    evaluatedLabels: [
      `${ltvLabel}: ${ltvMet ? "met" : "not met"}`,
      `${dtiLabel}: ${dtiMet ? "met" : "not met"}`,
      `${loanTypeLabel}: ${loanTypeMet ? "met" : "not met"}`,
    ],
    dti,
    ltv,
  };
}

// ---------------------------------------------------------------------------
// In-tx notification rows — routed through THE notification service
// (task-036, §4.8.1 single-service mandate; external delivery per preference
// for borrower recipients happens inside the service)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The approval gate (POST /api/applications/:id/approval-decision)
// ---------------------------------------------------------------------------

interface GateApplication {
  id: string;
  applicationNumber: string;
  borrowerUserId: string;
  workflowState: WorkflowState;
  versionStamp: number;
  outcome: "approved" | "denied" | null;
  currentVersionNumber: number;
  decidedAt: Date | null;
  escalationRequired: boolean;
  activeCaseworkerUserId: string | null;
}

async function loadGateApplication(applicationId: string): Promise<GateApplication | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      applicationNumber: true,
      borrowerUserId: true,
      workflowState: true,
      versionStamp: true,
      outcome: true,
      currentVersionNumber: true,
      decidedAt: true,
      escalationRequired: true,
      assignments: { where: { endedAt: null }, select: { caseworkerUserId: true }, take: 1 },
    },
  });
  if (!app) return null;
  return {
    id: app.id,
    applicationNumber: app.applicationNumber,
    borrowerUserId: app.borrowerUserId,
    workflowState: app.workflowState,
    versionStamp: app.versionStamp,
    outcome: app.outcome,
    currentVersionNumber: app.currentVersionNumber,
    decidedAt: app.decidedAt,
    escalationRequired: app.escalationRequired,
    activeCaseworkerUserId: app.assignments[0]?.caseworkerUserId ?? null,
  };
}

/**
 * INV-028 (SEC-5): a route into approved/conditional_approval must hold an
 * approve record at EVERY required level, and any deny record at a required
 * level permanently disqualifies it — a deny never satisfies. `newRecord`
 * is the record being written in this same transaction (it covers its own
 * level). Mixed approve/deny histories are the adversarial case (AC-31).
 */
async function assertGateSatisfied(
  tx: Prisma.TransactionClient,
  app: GateApplication,
  requiredLevels: number[],
  newRecord: { level: number; decision: "approve" | "deny" },
): Promise<void> {
  const records = await tx.approvalRecord.findMany({
    where: {
      applicationId: app.id,
      versionNumber: app.currentVersionNumber,
      level: { in: requiredLevels },
    },
    select: { level: true, decision: true },
  });
  const all = [...records, newRecord];
  for (const level of requiredLevels) {
    const atLevel = all.filter((r) => r.level === level);
    if (atLevel.some((r) => r.decision === "deny")) {
      throw workflowConflict(
        `A deny decision is recorded at approval level ${level} — a deny never satisfies an approval requirement`,
        app,
      );
    }
    if (!atLevel.some((r) => r.decision === "approve")) {
      throw workflowConflict(
        `An approve decision at level ${level} is required before this application can be approved`,
        app,
      );
    }
  }
}

/** Resolved routing for one decision request. */
interface DecisionRoute {
  level: number;
  toState: WorkflowState;
  transitionId: string;
  /** Escalation evaluation (Level-1 decisions only). */
  escalation: EscalationEvaluation | null;
}

/**
 * Execute one approval decision for the authenticated Supervisor. Throws
 * HttpProblem for every contract failure (403/404/409/400); returns the
 * serialized §A Application on success. `user` MUST come from the session
 * (audit integrity — actor identity is never read from the body).
 */
export async function executeApprovalDecision(
  user: SessionUser,
  applicationId: string,
  body: ApprovalDecisionRequestBody,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const app = await loadGateApplication(applicationId);
  if (!app) throw notFoundProblem("Application not found");

  // Early stamp check for a clean 409; the versionStamp WHERE clause inside
  // the transaction decides races (INV-039).
  if (app.versionStamp !== body.versionStamp) throw staleStampConflict();

  const conditions = (body.conditions ?? []).map((text) => text.trim()).filter((t) => t.length > 0);

  let route: DecisionRoute | null = null;
  try {
    route = await prisma.$transaction(async (tx) => {
      // INV-020: approver must be an ACTIVE SUPERVISOR at decision time — the
      // route guard alone would trust a stale session's role/status.
      await assertActiveSupervisor(tx, user.userId);

      const resolved = await resolveRoute(tx, user, app, body);
      const { level, toState, transitionId, escalation } = resolved;

      // 1. The ApprovalRecord — FIRST, so the INV-017 partial unique index
      //    decides concurrent same-level same-decision races (P2002 → 409).
      const record = await tx.approvalRecord.create({
        data: {
          applicationId: app.id,
          level,
          decision: body.decision,
          approverUserId: user.userId,
          notes: body.notes?.trim() || null,
          denialReasons: body.denialReasons ?? [],
          denialReasonOtherText: body.denialReasonOtherText?.trim() || null,
          criteriaEvaluated: escalation?.evaluatedLabels ?? [],
          dtiAtDecision: escalation?.dti ?? null,
          ltvAtDecision: escalation?.ltv ?? null,
          versionNumber: app.currentVersionNumber,
        },
      });

      // 2. Conditions bound to THIS record (INV-021 — same application by
      //    construction), status open until cleared.
      //    XBR-026: Condition rows exist ONLY for a decision that actually
      //    routes to Conditional Approval (T20/T26a). Escalated Review (T21),
      //    Approved (T19/T26) and Denied write none — resolveRoute already
      //    rejects the escalating-with-conditions case 409, and this guard makes
      //    it structurally impossible for a row to be bound to another route.
      if (conditions.length > 0 && toState !== "conditional_approval") {
        throw workflowConflict(
          "Conditions may only be recorded on a decision that routes to Conditional Approval",
          app,
        );
      }
      for (const text of conditions) {
        await tx.condition.create({
          data: {
            applicationId: app.id,
            approvalRecordId: record.id,
            text,
            status: "open",
          },
        });
      }

      // 3. INV-028 gate for routes INTO approved/conditional_approval.
      if (toState === "approved" || toState === "conditional_approval") {
        await assertGateSatisfied(tx, app, level === 2 ? [1, 2] : [1], {
          level,
          decision: body.decision,
        });
      }

      // 4. FLOW-004: the decision itself audited in-tx (actor from session only).
      await audit(tx, {
        actor: user.userId,
        role: user.role,
        actionType: "approval-decision",
        applicationId: app.id,
        entityType: "ApprovalRecord",
        entityId: record.id,
        summary:
          `Level ${level} ${body.decision} recorded on version ${app.currentVersionNumber}` +
          (body.decision === "deny" ? ` (reasons: ${(body.denialReasons ?? []).join(", ")})` : "") +
          (conditions.length > 0 ? ` with ${conditions.length} condition(s)` : ""),
        after: {
          level,
          decision: body.decision,
          criteriaEvaluated: escalation?.evaluatedLabels ?? [],
        },
        ip: meta.ip,
        requestId: meta.requestId,
      });

      // 5. The workflow transition — the engine's transactional core (stamped
      //    write + WorkflowHistory + workflow-transition audit), SAME tx: the
      //    record and the transition commit or roll back together.
      const now = new Date();
      const extraData: Prisma.ApplicationUpdateManyMutationInput = {};
      if (transitionId === "T21") {
        // Routed to escalated_review: record the evaluation on the application.
        extraData.escalationRequired = true;
        extraData.escalationCriteriaMet = escalation?.metLabels ?? [];
      } else if (transitionId === "T19" || transitionId === "T20") {
        // Live truth of the one-level evaluation.
        extraData.escalationRequired = false;
        extraData.escalationCriteriaMet = [];
      }
      if (toState === "approved" || toState === "denied") {
        extraData.decidedAt = app.decidedAt ?? now;
      }
      if (app.workflowState === "suspended") {
        // INV-032: previousStateForSuspend is non-null iff state is suspended.
        extraData.previousStateForSuspend = null;
        extraData.slaPausedAt = null;
      }

      // History note deliberately null: supervisor decision notes live on the
      // ApprovalRecord (staff surface); workflow history is borrower-visible
      // and the decision content reaches the borrower via the T27/T28 dispatch.
      await applyDecisionTransitionInTx(tx, {
        applicationId: app.id,
        fromState: app.workflowState,
        toState,
        transitionId,
        expectedVersionStamp: body.versionStamp,
        currentVersionNumber: app.currentVersionNumber,
        actorUserId: user.userId,
        actorRole: user.role,
        note: null,
        data: extraData,
        meta,
      });

      // 6. Per-transition notification effects (§4.5.3 annotations).
      await createDecisionNotifications(tx, user, app, transitionId, conditions.length);

      return resolved;
    });
  } catch (err) {
    if (isApprovalRecordUniqueViolation(err)) {
      // INV-017: the DB unique index decided a concurrent same-level race.
      throw workflowConflict(
        "This approval level has already been decided for this application version",
        app,
      );
    }
    throw err;
  }

  // ASYNC-003 / XBR-010: approved/denied → decision dispatch + SYS T27/T28.
  // Dispatch failure leaves the application in approved/denied with
  // decisionNotificationPending=true — contracted behavior, surfaced on the
  // serialized response, never an error to the caller.
  if (route && (route.toState === "approved" || route.toState === "denied")) {
    try {
      await executeDecisionDispatch(app.id, { requestId: meta.requestId });
    } catch (err) {
      // A concurrent-write conflict means someone advanced the file between
      // our commit and the dispatch — the retry path (task-036) owns it.
      if (!(err instanceof HttpProblem)) throw err;
    }
  }

  const row = await prisma.application.findUnique({
    where: { id: app.id },
    include: APPLICATION_INCLUDE,
  });
  if (!row) throw notFoundProblem("Application not found");
  return withSlaFields(
    serializeApplication(row as ApplicationWithRelations, user.role),
    row as unknown as SlaEnrichableRow,
  );
}

// ---------------------------------------------------------------------------
// Level-2 different-approver eligibility (INV-001) — single shared rule
// ---------------------------------------------------------------------------

export interface Level2DecisionEligibility {
  /** True when the viewer may record the Level-2 decision on this file. */
  eligible: boolean;
  /** Machine reason when ineligible; null when eligible. */
  reason: "no-l1-approve" | "self-l1-approver" | null;
}

/**
 * The INV-001 different-approver rule as one pure function: a Level-2 decision
 * requires a Level-1 APPROVE for the current version (a deny never satisfies)
 * recorded by a DIFFERENT supervisor than the viewer. `l1` is the LATEST
 * level-1 ApprovalRecord for the application's currentVersionNumber (or null).
 *
 * This is exactly the check `resolveRoute` enforces in its escalated_review
 * case; exported so the task-031 supervisor list (needs-my-Level-2 filter,
 * per-row eligibility labels) and the task-032 approval panel reuse the SAME
 * rule instead of re-deriving it.
 */
export function evaluateLevel2DecisionEligibility(
  l1: { approverUserId: string; decision: string } | null,
  viewerUserId: string,
): Level2DecisionEligibility {
  if (!l1 || l1.decision !== "approve") return { eligible: false, reason: "no-l1-approve" };
  if (l1.approverUserId === viewerUserId) return { eligible: false, reason: "self-l1-approver" };
  return { eligible: true, reason: null };
}

/**
 * Application.preliminaryRecommendation for the task-032 approval panel.
 * NOT a §A wire field: the caseworker recommendation (T15) reaches the
 * SERVER-rendered staff detail page as a component prop only — never a
 * borrower endpoint (S-7 keeps pre-decision staff work product staff-side).
 */
export async function getPreliminaryRecommendation(applicationId: string): Promise<string | null> {
  const row = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { preliminaryRecommendation: true },
  });
  return row?.preliminaryRecommendation ?? null;
}

/**
 * Derive the decision route from the CURRENT workflow state (§4.5.2/§4.5.3):
 * level, target state, transition id, and (for Level-1) the escalation
 * evaluation. Throws the contracted 403/409 problems.
 */
async function resolveRoute(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  app: GateApplication,
  body: ApprovalDecisionRequestBody,
): Promise<DecisionRoute> {
  switch (app.workflowState) {
    case "preliminary_decision": {
      // Level 1. Escalation evaluated at THIS moment for every L1 decision
      // (§4.5.2) and recorded on the record; routing:
      //   deny → denied (T22); approve + criteria met → escalated_review (T21)
      //   [escalation precedence over conditions — T20 requires "no escalation
      //   criterion met"]; approve + ≥1 condition → conditional_approval (T20);
      //   approve → approved (T19).
      // AMB-010: a Supervisor MAY Level-1-decide their own T15 recommendation —
      // deliberately no author comparison here.
      const escalation = await evaluateEscalation(tx, app.id);
      if (body.decision === "deny") {
        return { level: 1, toState: "denied", transitionId: "T22", escalation };
      }
      if (escalation.required) {
        // VR-086 / XBR-026: escalation takes precedence over conditions, and
        // conditions belong to the FINAL approving level. An L1 approve that
        // supplies conditions on an escalating file is rejected 409 BEFORE any
        // write — otherwise the rows would be created here, bound to the L1
        // record, and survive a Level-2 unconditional approve (T26) as open
        // conditions on a fully approved loan.
        if ((body.conditions ?? []).some((text) => text.trim().length > 0)) {
          throw workflowConflict(
            "Conditions may only be recorded on the final approving level — this file escalates to Level 2. " +
              "Record the Level-1 approve without conditions; the Level-2 Supervisor attaches any conditions.",
            app,
          );
        }
        return { level: 1, toState: "escalated_review", transitionId: "T21", escalation };
      }
      if ((body.conditions ?? []).length > 0) {
        return { level: 1, toState: "conditional_approval", transitionId: "T20", escalation };
      }
      return { level: 1, toState: "approved", transitionId: "T19", escalation };
    }

    case "escalated_review": {
      // Level 2. Requires an L1 APPROVE for this version (a deny never
      // satisfies — and would have routed to denied anyway) and a DIFFERENT
      // approver (INV-001).
      const l1 = await tx.approvalRecord.findFirst({
        where: { applicationId: app.id, versionNumber: app.currentVersionNumber, level: 1 },
        orderBy: { createdAt: "desc" },
        select: { approverUserId: true, decision: true },
      });
      if (!l1 || l1.decision !== "approve") {
        throw workflowConflict(
          "No Level-1 approve is recorded for this version — a Level-2 decision requires a Level-1 approval",
          app,
        );
      }
      if (l1.approverUserId === user.userId) {
        throw forbiddenProblem(
          "The Level-2 decision must be made by a different Supervisor than the Level-1 approver",
        );
      }
      if (body.decision === "deny") {
        return { level: 2, toState: "denied", transitionId: "T26b", escalation: null };
      }
      if ((body.conditions ?? []).length > 0) {
        return { level: 2, toState: "conditional_approval", transitionId: "T26a", escalation: null };
      }
      return { level: 2, toState: "approved", transitionId: "T26", escalation: null };
    }

    case "conditional_approval":
    case "suspended": {
      // T31 / T40: ONLY deny is valid through the gate in these states —
      // conditional_approval exits to approved via the transition endpoint
      // (T30, all conditions cleared) and suspended resumes via T38.
      if (body.decision !== "deny") {
        throw workflowConflict(
          app.workflowState === "conditional_approval"
            ? "Only a deny decision is valid here — final approval happens through the workflow transition once every condition is cleared"
            : "Only a deny decision is valid for a suspended application — resume it to continue processing",
          app,
        );
      }
      // Deny at the highest previously required level: 2 iff an escalated
      // Level-1 exists for this version (the escalation evaluation routed the
      // file through escalated_review), else 1.
      const l1 = await tx.approvalRecord.findFirst({
        where: { applicationId: app.id, versionNumber: app.currentVersionNumber, level: 1 },
        orderBy: { createdAt: "desc" },
        select: { approverUserId: true },
      });
      const level = l1 && app.escalationRequired ? 2 : 1;
      if (level === 2 && l1 && l1.approverUserId === user.userId) {
        // INV-001 is unqualified: an ApprovalRecord at level 2 must never have
        // the same approver as the Level-1 record on the same application/version.
        throw forbiddenProblem(
          "A Level-2 record must be made by a different Supervisor than the Level-1 approver",
        );
      }
      return {
        level,
        toState: "denied",
        transitionId: app.workflowState === "conditional_approval" ? "T31" : "T40",
        escalation: null,
      };
    }

    default:
      throw workflowConflict(
        `No approval decision may be recorded while the application is in ${workflowStateLabel(app.workflowState)}`,
        app,
      );
  }
}

/** §4.5.3 notify annotations for gate-performed transitions (in-tx, task-036 seam). */
async function createDecisionNotifications(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  app: GateApplication,
  transitionId: string,
  conditionCount: number,
): Promise<void> {
  const n = app.applicationNumber;

  if (transitionId === "T20" || transitionId === "T26a") {
    // "notify B and C" — conditional approval with conditions to clear.
    await notifyInTx(
      tx,
      app.borrowerUserId,
      "conditional-approval",
      "Conditionally approved",
      `Your application ${n} has been conditionally approved. ${conditionCount} condition(s) must be cleared before final approval.`,
      app.id,
    );
    if (app.activeCaseworkerUserId) {
      await notifyInTx(
        tx,
        app.activeCaseworkerUserId,
        "conditional-approval",
        "Application conditionally approved",
        `Application ${n} was conditionally approved with ${conditionCount} condition(s) to clear.`,
        app.id,
      );
    }
    return;
  }

  if (transitionId === "T21") {
    // "notify all other S (pending Level-2)" — every active Supervisor except
    // the Level-1 approver (who cannot take the Level-2 decision, INV-001).
    const supervisors = await tx.user.findMany({
      where: { role: "SUPERVISOR", status: "active", id: { not: user.userId } },
      select: { id: true },
    });
    for (const supervisor of supervisors) {
      await notifyInTx(
        tx,
        supervisor.id,
        "pending-level-2",
        "Level-2 approval needed",
        `Application ${n} was Level-1 approved with escalation criteria met and awaits a Level-2 decision by a different supervisor.`,
        app.id,
      );
    }
  }
  // T19/T22/T26/T26b/T31/T40: the borrower learns the outcome through the
  // decision dispatch (SYS T27/T28, ASYNC-003) — no in-tx notification here.
}

// ---------------------------------------------------------------------------
// §A wire serializers (field names verbatim from contracts.json)
// ---------------------------------------------------------------------------

type NameSlice = { firstName: string; lastName: string } | null;

function displayName(user: NameSlice): string {
  return user ? `${user.firstName} ${user.lastName}`.trim() : "";
}

export type ConditionWithRelations = Condition & {
  clearedByUser?: NameSlice;
};

/** contracts.md §A ConditionInfo — exact field names; staff as display names only (S-6). */
export function toConditionInfo(row: ConditionWithRelations): Record<string, unknown> {
  return {
    id: row.id,
    applicationId: row.applicationId,
    approvalRecordId: row.approvalRecordId,
    text: row.text,
    status: row.status,
    clearedByName: row.clearedByUser ? displayName(row.clearedByUser) : undefined,
    clearedAt: row.clearedAt ? row.clearedAt.toISOString() : undefined,
  };
}

export type ApprovalRecordWithRelations = ApprovalRecord & {
  approverUser: { firstName: string; lastName: string };
  conditions: ConditionWithRelations[];
};

/** contracts.md §A ApprovalRecordInfo — exact field names; approverName is display-only (S-6). */
export function toApprovalRecordInfo(row: ApprovalRecordWithRelations): Record<string, unknown> {
  return {
    id: row.id,
    applicationId: row.applicationId,
    level: row.level,
    decision: row.decision,
    approverName: displayName(row.approverUser),
    notes: row.notes ?? undefined,
    conditions: row.conditions.length > 0 ? row.conditions.map((c) => toConditionInfo(c)) : undefined,
    denialReasons: row.denialReasons.length > 0 ? row.denialReasons : undefined,
    denialReasonOtherText: row.denialReasonOtherText ?? undefined,
    criteriaEvaluated: row.criteriaEvaluated.length > 0 ? row.criteriaEvaluated : undefined,
    dtiAtDecision: row.dtiAtDecision === null ? undefined : Number(row.dtiAtDecision),
    ltvAtDecision: row.ltvAtDecision === null ? undefined : Number(row.ltvAtDecision),
    versionNumber: row.versionNumber,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/applications/:id/approvals — ApprovalList (max 25, no pagination)
// ---------------------------------------------------------------------------

/**
 * List the approval records (with nested conditions) for one application.
 * RECORD-LEVEL SCOPING: a caseworker needs FULL read access (current ACTIVE
 * assignment, S-2a) — the unassigned summary level (S-2b) never exposes
 * decision detail; supervisors read everything (S-4).
 */
export async function listApprovals(
  user: SessionUser,
  applicationId: string,
): Promise<Record<string, unknown>> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found") throw notFoundProblem("Application not found");
    throw forbiddenProblem("You are not assigned to this application");
  }
  if (access.level !== "full") {
    throw forbiddenProblem("You are not assigned to this application");
  }

  const rows = await prisma.approvalRecord.findMany({
    where: { applicationId },
    orderBy: { createdAt: "asc" },
    take: 25,
    include: {
      approverUser: { select: { firstName: true, lastName: true } },
      conditions: {
        orderBy: { createdAt: "asc" },
        include: { clearedByUser: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  return { rows: rows.map((row) => toApprovalRecordInfo(row as ApprovalRecordWithRelations)) };
}

// ---------------------------------------------------------------------------
// POST /api/conditions/:id/clear — ConditionInfo (XBR-011)
// ---------------------------------------------------------------------------

/**
 * Clear one condition. RECORD-LEVEL SCOPING: a caseworker must hold the
 * current ACTIVE assignment on the OWNING application (a role check alone
 * would let Caseworker A clear conditions on Caseworker B's file); supervisors
 * may clear on any application (S-4). Already-cleared → 409 (the status WHERE
 * clause decides concurrent clears). Clearing notifies the caseworker
 * (XBR-011) and is audited in the same transaction; T30's all-cleared gate
 * lives in the transition engine (task-019) and reads these rows live.
 */
export async function clearCondition(
  user: SessionUser,
  conditionId: string,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const condition = await prisma.condition.findUnique({
    where: { id: conditionId },
    select: {
      id: true,
      applicationId: true,
      status: true,
      text: true,
      application: {
        select: {
          applicationNumber: true,
          assignments: { where: { endedAt: null }, select: { caseworkerUserId: true }, take: 1 },
        },
      },
    },
  });
  if (!condition) throw notFoundProblem("Condition not found");

  const activeCaseworkerUserId = condition.application.assignments[0]?.caseworkerUserId ?? null;
  if (user.role === "CASEWORKER" && activeCaseworkerUserId !== user.userId) {
    throw forbiddenProblem("You are not assigned to this application");
  }

  if (condition.status === "cleared") {
    throw new HttpProblem(409, ERROR_CODES.conflict, "This condition has already been cleared");
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // CHECK-THEN-ACT GUARD: the status WHERE clause decides concurrent clears.
    const updated = await tx.condition.updateMany({
      where: { id: conditionId, status: "open" },
      data: { status: "cleared", clearedByUserId: user.userId, clearedAt: now },
    });
    if (updated.count === 0) {
      throw new HttpProblem(409, ERROR_CODES.conflict, "This condition has already been cleared");
    }

    // XBR-011: clearing a condition notifies the caseworker (in-app row in-tx —
    // task-036 seam, same pattern as src/lib/services/document.ts ~line 985).
    // Self-notification is skipped when the clearer IS the assigned caseworker.
    if (activeCaseworkerUserId && activeCaseworkerUserId !== user.userId) {
      await notifyInTx(
        tx,
        activeCaseworkerUserId,
        "condition-cleared",
        "Condition cleared",
        `A condition on application ${condition.application.applicationNumber} was cleared: ${condition.text.slice(0, 200)}`,
        condition.applicationId,
      );
    }

    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "condition-clear",
      applicationId: condition.applicationId,
      entityType: "Condition",
      entityId: condition.id,
      summary: `Condition cleared: ${condition.text.slice(0, 120)}`,
      before: { status: "open" },
      after: { status: "cleared" },
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  const cleared = await prisma.condition.findUnique({
    where: { id: conditionId },
    include: { clearedByUser: { select: { firstName: true, lastName: true } } },
  });
  if (!cleared) throw notFoundProblem("Condition not found");
  return toConditionInfo(cleared as ConditionWithRelations);
}
