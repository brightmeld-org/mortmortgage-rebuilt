// Decision dispatch + SYS T27/T28 executor (task-019, ASYNC-003, XBR-010,
// INV-022, WF-033/WF-034/WF-049).
//
// `executeDecisionDispatch(applicationId)` is the ONLY code path that performs
// T27 (approved → borrower_notified, outcome=approved) and T28 (denied →
// borrower_notified, outcome=denied). HTTP callers of the transition endpoint
// are rejected 409 for these toStates (workflow-engine.ts); this executor is
// invoked internally:
//   - by the transition engine after a committed T30 (conditional_approval →
//     approved with every condition cleared) — contracts §B semantics;
//   - by the approval gate (task-020) after its gate reaches approved/denied;
//   - by the decision-notification retry path + boot reconciler (task-036).
//
// Semantics (ASYNC-003): the dispatch (in-app Notification row to the borrower
// carrying decision + formal-note content + denial reasons, XBR-010/ASM-011)
// and the SYS transition (state, outcome, WorkflowHistory, audit) happen in ONE
// transaction. On dispatch failure the application STAYS in approved/denied and
// decisionNotificationPending is set true (WF-049 pending-retry indicator).
//
// task-036 (IMPLEMENTED behind the original seam names):
//   - `dispatchDecisionNotification` now routes through THE notification
//     service (src/lib/services/notifications.ts) in "in-tx" delivery mode:
//     the in-app row AND the external email/SMS per borrower preference
//     (§6.3.8 simulation) happen inside the T27/T28 transaction; ANY delivery
//     failure (e.g. a @bounce.example address) throws, aborting the
//     transition — T27/T28 only after successful dispatch (WF-049).
//   - Serial-per-key (`decision-dispatch:{applicationId}`): the versionStamp
//     WHERE clause remains the DB authority — of two concurrent dispatches
//     exactly one commits; the loser matches 0 rows and rolls back.
//   - Automatic retry (ASYNC-003: 3 attempts, exponential, initial 60s): a
//     dispatch failure schedules an in-process guarded re-drive; crash
//     recovery is `reconcileStuckDecisionDispatches()` (exported for boot
//     wiring by task-045), which re-drives every application still sitting in
//     approved/denied with decisionNotificationPending=true.
//   - Staff retry: `retryDecisionNotification` backs
//     POST /api/applications/:id/decision-notification/retry.
// T27/T28 remain reachable ONLY through `executeDecisionDispatch`.

import type { Outcome, Prisma, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import {
  APPLICATION_INCLUDE,
  serializeApplication,
  type ApplicationWithRelations,
} from "@/lib/services/application-serializer";
import { withSlaFields, type SlaEnrichableRow } from "@/lib/services/sla";
import { allowedTransitionsFromForOutcome, workflowStateLabel } from "@/lib/pure/workflow";

export interface DecisionDispatchMeta {
  requestId?: string | null;
}

export interface DecisionDispatchResult {
  /** True when the notification was dispatched and the SYS transition committed. */
  dispatched: boolean;
  /** Application state after this call (borrower_notified, or approved/denied on failure). */
  workflowState: WorkflowState;
  /** Outcome recorded by T27/T28 (set only when dispatched). */
  outcome: Outcome;
}

export interface DecisionNotificationInput {
  applicationId: string;
  applicationNumber: string;
  borrowerUserId: string;
  outcome: Outcome;
  /** Formal-note content from the deciding ApprovalRecord (absent when none recorded). */
  notes: string | null;
  /** DenialReason machine values (denied outcome only). */
  denialReasons: string[];
  denialReasonOtherText: string | null;
}

/**
 * The named decision-dispatch seam (ASYNC-003 / XBR-010 / ASM-011): deliver the
 * decision + formal-note content to the borrower. Runs INSIDE the T27/T28
 * transaction — a throw here aborts the transition, leaving the application in
 * approved/denied for retry. task-036 extends this function (see module header).
 */
export async function dispatchDecisionNotification(
  tx: Prisma.TransactionClient,
  input: DecisionNotificationInput,
): Promise<void> {
  const approved = input.outcome === "approved";
  const lines: string[] = [
    approved
      ? `Your mortgage application ${input.applicationNumber} has been approved.`
      : `Your mortgage application ${input.applicationNumber} has been denied.`,
  ];
  if (!approved && input.denialReasons.length > 0) {
    const reasons = input.denialReasons.map((r) =>
      r === "other" && input.denialReasonOtherText ? `other: ${input.denialReasonOtherText}` : r,
    );
    lines.push(`Reasons: ${reasons.join(", ")}`);
  }
  if (input.notes) lines.push(input.notes);

  // Single-service mandate (§4.8.1) + ASYNC-003 single-tx semantics: in-app
  // row AND external delivery per preference inside THIS transaction; a
  // delivery failure throws NotificationDeliveryError, aborting T27/T28.
  await createNotification(tx, {
    recipientUserId: input.borrowerUserId,
    type: "decision",
    title: approved ? "Application approved" : "Application decision",
    body: lines.join("\n"),
    applicationId: input.applicationId,
    externalDelivery: "in-tx",
  });
}

/**
 * Perform the SYS T27/T28 transition for an application currently in
 * approved/denied. Throws HttpProblem 404 (unknown id) or 409 (not in a
 * dispatchable state / concurrent-write stale stamp). Any OTHER failure —
 * i.e. the dispatch itself — is absorbed: the application remains in
 * approved/denied with decisionNotificationPending=true and
 * `{ dispatched: false }` is returned (WF-049).
 */
export async function executeDecisionDispatch(
  applicationId: string,
  meta: DecisionDispatchMeta = {},
): Promise<DecisionDispatchResult> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      applicationNumber: true,
      borrowerUserId: true,
      workflowState: true,
      versionStamp: true,
      currentVersionNumber: true,
    },
  });
  if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

  if (app.workflowState !== "approved" && app.workflowState !== "denied") {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      `Decision dispatch applies only to Approved or Denied applications (current state: ${workflowStateLabel(app.workflowState)})`,
      {
        currentState: app.workflowState,
        allowedTransitions: allowedTransitionsFromForOutcome(app.workflowState, null),
      },
    );
  }

  const outcome: Outcome = app.workflowState === "approved" ? "approved" : "denied";
  const transitionId = outcome === "approved" ? "T27" : "T28";

  // Decision content: the most recent matching ApprovalRecord (task-020 writes
  // them; the T30 path reuses the conditional approval's approving record).
  // Live-derived; tolerates absence (no record → decision line only).
  const record = await prisma.approvalRecord.findFirst({
    where: { applicationId, decision: outcome === "approved" ? "approve" : "deny" },
    orderBy: { createdAt: "desc" },
    select: { notes: true, denialReasons: true, denialReasonOtherText: true },
  });

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Dispatch (throw = abort: stays approved/denied, marked pending below).
      await dispatchDecisionNotification(tx, {
        applicationId: app.id,
        applicationNumber: app.applicationNumber,
        borrowerUserId: app.borrowerUserId,
        outcome,
        notes: record?.notes ?? null,
        denialReasons: record?.denialReasons ?? [],
        denialReasonOtherText: record?.denialReasonOtherText ?? null,
      });

      // 2. SYS transition + outcome in the SAME transaction (INV-022), race-safe
      //    via the versionStamp WHERE clause (INV-039).
      const now = new Date();
      const updated = await tx.application.updateMany({
        where: { id: app.id, versionStamp: app.versionStamp },
        data: {
          workflowState: "borrower_notified",
          outcome,
          stateEnteredAt: now,
          versionStamp: { increment: 1 },
          decisionNotificationPending: false,
        },
      });
      if (updated.count === 0) {
        throw new HttpProblem(
          409,
          ERROR_CODES.conflict,
          "The application changed while dispatching the decision — retry",
          { currentState: app.workflowState },
        );
      }

      // 3. WorkflowHistory + audit, all-or-nothing (XBR-013). SYS actor: null
      //    user id, SYSTEM role.
      await tx.workflowHistory.create({
        data: {
          applicationId: app.id,
          fromState: app.workflowState,
          toState: "borrower_notified",
          actorUserId: null,
          actorRole: "SYSTEM",
          versionNumber: app.currentVersionNumber > 0 ? app.currentVersionNumber : null,
        },
      });
      await audit(tx, {
        actor: null,
        role: "SYSTEM",
        actionType: "workflow-transition",
        applicationId: app.id,
        entityType: "Application",
        entityId: app.id,
        summary: `${transitionId}: ${workflowStateLabel(app.workflowState)} → ${workflowStateLabel("borrower_notified")} (outcome ${outcome}, decision dispatched)`,
        requestId: meta.requestId ?? null,
      });
    });
  } catch (err) {
    // Contract failures (stale stamp) propagate — nothing to retry.
    if (err instanceof HttpProblem) throw err;
    // Dispatch failure: stay in approved/denied with the pending-retry indicator
    // (WF-049). Best-effort flag write; the boot reconciler re-surfaces stuck
    // dispatches even if this write also fails.
    await prisma.application
      .update({ where: { id: app.id }, data: { decisionNotificationPending: true } })
      .catch(() => undefined);
    // ASYNC-003 automatic retry (3 attempts, exponential, initial 60s).
    scheduleDecisionDispatchRetry(app.id);
    return { dispatched: false, workflowState: app.workflowState, outcome };
  }

  decisionRetryAttempts.delete(applicationId);
  return { dispatched: true, workflowState: "borrower_notified", outcome };
}

// ---------------------------------------------------------------------------
// ASYNC-003 retry + reconciler (task-036)
// ---------------------------------------------------------------------------

/**
 * In-process automatic-retry bookkeeping (ASYNC-003 retryPolicy: maxAttempts 3
 * including the original dispatch, exponential backoff, initial 60s). The map
 * is deliberately NOT persistent: the DURABLE signal is
 * Application.decisionNotificationPending, and crash recovery is
 * `reconcileStuckDecisionDispatches()` (reconciler-on-boot) — a lost timer can
 * only ever delay a retry, never lose the dispatch.
 */
const decisionRetryAttempts = new Map<string, number>();

export const DECISION_DISPATCH_MAX_ATTEMPTS = 3;
export const DECISION_DISPATCH_RETRY_INITIAL_DELAY_MS = 60_000;

function scheduleDecisionDispatchRetry(applicationId: string): void {
  const priorAttempts = decisionRetryAttempts.get(applicationId) ?? 1;
  if (priorAttempts >= DECISION_DISPATCH_MAX_ATTEMPTS) return; // exhausted → manual retry / reconciler
  decisionRetryAttempts.set(applicationId, priorAttempts + 1);
  const delay = DECISION_DISPATCH_RETRY_INITIAL_DELAY_MS * 2 ** (priorAttempts - 1);
  const timer = setTimeout(() => {
    // Guarded by executeDecisionDispatch itself: a 409 (already transitioned /
    // state changed) or another failure is absorbed — never unhandled.
    executeDecisionDispatch(applicationId).catch(() => undefined);
  }, delay);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Boot reconciler (ASYNC-003 crash recovery): re-drive every application still
 * in approved/denied with the pending-retry indicator set. Exported for boot
 * wiring (task-045); safe to call any time — each re-drive goes through the
 * sole executor, so a still-failing dispatch simply stays pending.
 *
 * @returns the number of applications whose dispatch completed.
 */
export async function reconcileStuckDecisionDispatches(): Promise<number> {
  const stuck = await prisma.application.findMany({
    where: {
      workflowState: { in: ["approved", "denied"] },
      decisionNotificationPending: true,
    },
    select: { id: true },
    take: 100,
  });
  let dispatched = 0;
  for (const row of stuck) {
    try {
      const result = await executeDecisionDispatch(row.id);
      if (result.dispatched) dispatched += 1;
    } catch {
      // 404/409 contract failures: nothing to re-drive for this row.
    }
  }
  return dispatched;
}

// ---------------------------------------------------------------------------
// Staff retry — POST /api/applications/:id/decision-notification/retry
// ---------------------------------------------------------------------------

/**
 * WF-049 staff retry action: re-drives the sole T27/T28 executor for an
 * application flagged decisionNotificationPending. Record-level scoping: a
 * caseworker must hold the active assignment (supervisors full — S-4). 404
 * unknown id; 409 when no decision notification is pending. The retry action
 * itself is audited; a successful dispatch additionally audits the SYS
 * transition inside the executor. Returns the §A Application (fresh state —
 * borrower_notified on success, approved/denied still pending on failure).
 */
export async function retryDecisionNotification(
  user: SessionUser,
  applicationId: string,
  meta: DecisionDispatchMeta & RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const access = await canWriteApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found") {
      throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
    }
    throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
  }

  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, applicationNumber: true, workflowState: true, decisionNotificationPending: true },
  });
  if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  if (
    !app.decisionNotificationPending ||
    (app.workflowState !== "approved" && app.workflowState !== "denied")
  ) {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "No decision notification is pending retry for this application",
      {
        currentState: app.workflowState,
        allowedTransitions: allowedTransitionsFromForOutcome(app.workflowState, null),
      },
    );
  }

  // Staff mutation → audited (its own tx; the dispatch outcome audits separately).
  await prisma.$transaction(async (tx) => {
    await audit(tx as AuditTransactionClient, {
      actor: user.userId, // session identity only
      role: user.role,
      actionType: "notification-retry",
      applicationId: app.id,
      entityType: "Application",
      entityId: app.id,
      summary: `Decision-notification dispatch retried on application ${app.applicationNumber} (state ${workflowStateLabel(app.workflowState)})`,
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  await executeDecisionDispatch(applicationId, { requestId: meta.requestId });

  const row = await prisma.application.findUnique({
    where: { id: applicationId },
    include: APPLICATION_INCLUDE,
  });
  if (!row) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  return (await withSlaFields(
    serializeApplication(row as ApplicationWithRelations, user.role),
    row as unknown as SlaEnrichableRow,
  )) as Record<string, unknown>;
}
