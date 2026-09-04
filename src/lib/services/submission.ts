// Submission service (task-011) — the T1/T36 SUBSTANCE the task-019 transition
// engine invokes (XBR-001/XBR-002/XBR-012, INV-008/011/016/023/025/029/039).
//
// NOT an endpoint. `submitApplicationInTx(tx, ...)` performs, inside the CALLER's
// open transaction:
//   (a) submission gate re-validation: §4.2.4 required fields via the SHARED pure
//       engine (validateForSubmission), LTV <= configured block (an engine error
//       issue), age >= 18 (engine, INV-025), and currently-valid signatures from
//       EVERY borrower (INV-029 — hash-checked, co-borrower included);
//   (b) one-active enforcement (INV-016): the DB partial unique index
//       Application_borrowerUserId_active_key is the race authority — a unique
//       violation maps (via resolveSubmissionUniqueViolation) to 409 with the
//       EXACT message "You already have an application in underwriting:
//       MM-YYYY-NNNNNN" naming the EXISTING active application;
//   (c) immutable ApplicationVersion snapshot versionNumber = current + 1
//       (INV-008), reason initial-submission (T1) / resubmission (T36), masked
//       snapshot (no raw SSN/DOB, account numbers as last4);
//   (d) T36 increments revisionCycles EXACTLY once (INV-011);
//   (e) versionStamp verification + increment (INV-039);
//   (f) WorkflowHistory row + audit entry in the same transaction (XBR-013).
// Corrections NEVER create versions — nothing here is reachable from the
// corrections path (task-023).
//
// task-019 SEAM (consumed): the transition engine
// (src/lib/services/workflow-engine.ts) is the single owner of state-change +
// history + notifications for POST /api/applications/:id/transition. It calls
// `submitApplicationInTx` inside ITS transaction and layers the XBR-001/XBR-012
// notification + staleness effects on top. The standalone `submitApplication`
// wrapper below remains for direct service-level callers and preserves the
// original behavior exactly.

import type { Prisma, UserRole, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { audit } from "@/lib/services/audit";
import {
  buildVersionSnapshot,
  APPLICATION_INCLUDE,
  type ApplicationWithRelations,
} from "@/lib/services/application-serializer";
import { buildValidationInput } from "@/lib/services/application";
import { currentlySignedOrdinals } from "@/lib/services/signature-validity";
import { validateForSubmission, type ValidationIssue } from "@/lib/pure/urla-validation";
import { workflowStateLabel } from "@/lib/pure/workflow";

export interface SubmissionMeta {
  ip?: string | null;
  requestId?: string | null;
  /** Actor role for audit/history rows; the owning borrower in every T1/T36 path. */
  actorRole?: UserRole;
}

export interface SubmissionResult {
  applicationId: string;
  applicationNumber: string;
  /** T1: "application_received"; T36: "completeness_validated" (§A map). */
  workflowState: WorkflowState;
  versionNumber: number;
  /** "initial-submission" | "resubmission" (VersionReason, verbatim). */
  reason: string;
  revisionCycles: number;
  versionStamp: number;
  /** WorkflowHistory.id of the transition row written for this submission. */
  workflowHistoryId: string;
}

/** One-active 409 (AC-11): the EXACT contract message naming the existing application. */
export function oneActiveConflict(existingApplicationNumber: string): HttpProblem {
  return new HttpProblem(
    409,
    ERROR_CODES.conflict,
    `You already have an application in underwriting: ${existingApplicationNumber}`,
  );
}

function validationConflict(errors: ValidationIssue[]): HttpProblem {
  return new HttpProblem(400, ERROR_CODES.validationError, "The application is not ready to submit", {
    details: errors.map((e) => `${e.section}${e.borrowerOrdinal ? `/borrower${e.borrowerOrdinal}` : ""}.${e.fieldPath}: ${e.message}`),
  });
}

/**
 * The T1/T36 submission substance, executed inside the CALLER's open transaction
 * (the task-019 engine's, or `submitApplication`'s below). Throws HttpProblem for
 * every contract failure. P2002 unique violations propagate raw — the caller maps
 * them AFTER its transaction aborts via `resolveSubmissionUniqueViolation`.
 * `userId` MUST come from the authenticated session (audit integrity).
 */
export async function submitApplicationInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  applicationId: string,
  expectedVersionStamp: number,
  meta: SubmissionMeta = {},
): Promise<SubmissionResult> {
  const actorRole: UserRole = meta.actorRole ?? "BORROWER";

  const app = await tx.application.findUnique({
    where: { id: applicationId },
    include: APPLICATION_INCLUDE,
  });
  if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

  // INV-026/INV-027: submission is the owning borrower's act — period.
  if (app.borrowerUserId !== userId) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  }

  // T1 from draft, T36 from revision_requested — nothing else submits.
  let toState: WorkflowState;
  let reason: "initial-submission" | "resubmission";
  if (app.workflowState === "draft") {
    toState = "application_received";
    reason = "initial-submission";
  } else if (app.workflowState === "revision_requested") {
    toState = "completeness_validated";
    reason = "resubmission";
  } else {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      `Cannot submit from ${workflowStateLabel(app.workflowState)}`,
      { currentState: app.workflowState },
    );
  }

  // INV-039: stamp check before any effect.
  if (app.versionStamp !== expectedVersionStamp) {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "This application was changed in another tab or session — reload before submitting",
    );
  }

  // (a) Submission gate: required fields + conditionals + LTV block + age >= 18
  // via THE shared engine (the same authority GET /validation serves).
  const validationInput = await buildValidationInput(tx, applicationId);
  const gate = validateForSubmission(validationInput);
  if (!gate.ok) throw validationConflict(gate.errors);

  // INV-029: every borrower holds a CURRENTLY-VALID signature (hash-checked).
  const signedOrdinals = await currentlySignedOrdinals(tx, applicationId);
  const unsigned = app.borrowers.filter((b) => !signedOrdinals.includes(b.ordinal));
  if (unsigned.length > 0) {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      `Every borrower must sign before submitting (missing or invalidated signature for borrower ${unsigned
        .map((b) => b.ordinal)
        .join(", ")})`,
    );
  }

  // (c) INV-008: immutable snapshot, versionNumber = current + 1.
  const versionNumber = app.currentVersionNumber + 1;
  await tx.applicationVersion.create({
    data: {
      applicationId,
      versionNumber,
      reason,
      snapshot: buildVersionSnapshot(app as ApplicationWithRelations),
      createdByUserId: userId,
    },
  });

  // (b)+(d)+(e): state write, one-active via the partial unique index,
  // revisionCycles exactly once on T36, versionStamp in the WHERE clause
  // (FT-74: check-then-act made race-safe).
  const now = new Date();
  const updated = await tx.application.updateMany({
    where: { id: applicationId, versionStamp: expectedVersionStamp },
    data: {
      workflowState: toState,
      stateEnteredAt: now,
      currentVersionNumber: versionNumber,
      versionStamp: { increment: 1 },
      ...(reason === "initial-submission" ? { submittedAt: now } : {}),
      ...(reason === "resubmission" ? { revisionCycles: { increment: 1 } } : {}),
    },
  });
  if (updated.count === 0) {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "This application was changed in another tab or session — reload before submitting",
    );
  }

  // (f) WorkflowHistory row (XBR-013) in the same transaction.
  const history = await tx.workflowHistory.create({
    data: {
      applicationId,
      fromState: app.workflowState,
      toState,
      actorUserId: userId,
      actorRole,
      versionNumber,
    },
  });

  // (f) Audit in the same transaction (failure rolls everything back).
  await audit(tx, {
    actor: userId,
    role: actorRole,
    actionType: "application-submitted",
    applicationId,
    entityType: "Application",
    entityId: applicationId,
    summary:
      reason === "initial-submission"
        ? `Application ${app.applicationNumber} submitted (Version ${versionNumber})`
        : `Application ${app.applicationNumber} resubmitted (Version ${versionNumber}, revision cycle ${app.revisionCycles + 1})`,
    ip: meta.ip ?? null,
    requestId: meta.requestId ?? null,
  });

  return {
    applicationId,
    applicationNumber: app.applicationNumber,
    workflowState: toState,
    versionNumber,
    reason,
    revisionCycles: app.revisionCycles + (reason === "resubmission" ? 1 : 0),
    versionStamp: expectedVersionStamp + 1,
    workflowHistoryId: history.id,
  };
}

/**
 * Map a P2002 unique violation raised during a submission transaction to its
 * contract 409 (INV-016 one-active with the exact named-application message, or
 * the generic concurrent-change reload conflict). Returns null when `err` is not
 * a unique violation — the caller rethrows the original error.
 * Runs AFTER the aborted transaction (fresh reads on the global client).
 */
export async function resolveSubmissionUniqueViolation(
  err: unknown,
  userId: string,
  applicationId: string,
): Promise<HttpProblem | null> {
  if (!isUniqueViolation(err)) return null;
  // INV-016: the partial unique index (Application_borrowerUserId_active_key)
  // rejected a second active application — the DB is the race authority. Any
  // remaining P2002 inside the transaction (e.g. the (applicationId,
  // versionNumber) unique under a concurrent double-submit of the SAME
  // application) is a concurrency conflict → 409 reload.
  const existing = await prisma.application.findFirst({
    where: {
      borrowerUserId: userId,
      id: { not: applicationId },
      workflowState: {
        in: [
          "application_received", "completeness_validated", "documents_received",
          "aus_executed", "preliminary_decision", "escalated_review",
          "conditional_approval", "approved", "denied", "borrower_notified",
          "revision_requested", "suspended",
        ],
      },
    },
    select: { applicationNumber: true },
    orderBy: { submittedAt: "desc" },
  });
  if (existing) return oneActiveConflict(existing.applicationNumber);
  return new HttpProblem(
    409,
    ERROR_CODES.conflict,
    "This application was changed in another tab or session — reload before submitting",
  );
}

/**
 * Standalone T1/T36 submission for direct service-level callers: wraps
 * `submitApplicationInTx` in its own transaction and maps unique violations.
 * The HTTP transition endpoint does NOT use this — the task-019 engine owns
 * that path and composes the in-tx core with its notification effects.
 */
export async function submitApplication(
  userId: string,
  applicationId: string,
  expectedVersionStamp: number,
  meta: SubmissionMeta = {},
): Promise<SubmissionResult> {
  try {
    return await prisma.$transaction(async (tx) =>
      submitApplicationInTx(tx, userId, applicationId, expectedVersionStamp, meta),
    );
  } catch (err) {
    const mapped = await resolveSubmissionUniqueViolation(err, userId, applicationId);
    if (mapped) throw mapped;
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: string }).code === "P2002";
}
