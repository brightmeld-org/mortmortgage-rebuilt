// Claim + assignment operations service (task-022) — REQ-047, REQ-056, REQ-058,
// NFR-005, SEC-4, INV-015, INV-019, XBR-014, WALK-007.
//
// OPERATIONS (contracts §B):
//   claim      POST /api/applications/:id/claim         (caseworker, supervisor)
//   manual     POST /api/applications/:id/assignment     (supervisor)
//   bulk       POST /api/supervisor/assignments/bulk     (supervisor)
//   auto       POST /api/supervisor/assignments/auto     (supervisor)
//   reassign   POST /api/applications/:id/reassignment   (supervisor)
//   history    GET  /api/applications/:id/assignments    (supervisor)
//
// CONCURRENCY (INV-015 / SEC-4 / XBR-014): every operation runs close-prior +
// create-new in ONE prisma.$transaction; the DB partial unique index
// `CaseworkerAssignment_applicationId_active_key` (applicationId WHERE
// "endedAt" IS NULL, init migration) is the RACE AUTHORITY — the in-tx
// check-then-act is a courtesy fast path, and the P2002 unique violation from
// a lost race is caught and mapped to the contracted 409 carrying the current
// holder's name ("already claimed by [name]", §4.4.1 / AC-24).
//
// ASSIGNED-VS-UNASSIGNED SEMANTICS (documented interpretation):
//   - claim / manual / bulk / auto REQUIRE an unassigned application; an
//     existing active assignment is a 409 (or per-application conflict result)
//     naming the holder. This is what makes AC-24's "exactly one succeeds, the
//     other receives a conflict" true for SEQUENTIAL seconds as well as races,
//     and matches VR-113 ("each id must be unassigned") and §4.6.2 "Under
//     concurrent claim/assign attempts exactly one succeeds".
//   - reassign is the explicit move operation: it REQUIRES an active
//     assignment, closes it (endedAt + endReason) and creates the new one in
//     the same transaction, requires a reason (VR-115), and notifies BOTH
//     caseworkers (§4.6.2).
//
// STATE GATES: claim/auto target the unassigned queue, so the application must
// be in a CLAIMABLE state (§4.4.1, guard.ts CLAIMABLE_STATES). Manual/bulk/
// reassign are supervisor-directed and gate only on "workable": never draft
// (borrower-private) and never terminal (withdrawn / declined_by_borrower).
//
// TARGETS (INV-019, VR-108): assignments may only target ACTIVE CASEWORKER
// users — checked INSIDE the transaction (transactional-check). Supervisor
// self-claim is the single exception, permitted on claim only. An invalid
// target is the contract's validation error (400, VR-108 wording).
//
// ADMIN-ENDPOINT INVARIANT: assignment operations NEVER change workflowState.
// AUDIT (SEC-8 / AC-26): every event audited in-tx with actor (session only),
// method, reason, and before/after holder. NOTIFICATIONS (§4.5.7): the new
// caseworker is notified on every method (claim = claim confirmation);
// reassignment additionally notifies the previous caseworker.
// Notifications route through THE notification service (task-036,
// src/lib/services/notifications.ts — §4.8.1 single-service mandate).

import { Prisma, type AssignmentMethod, type CaseworkerAssignment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import { CLAIMABLE_STATES } from "@/lib/guard";
import { TERMINAL_STATES } from "@/lib/pure/workflow";
import { getBooleanSetting, getNumberSetting } from "@/lib/services/config";
import {
  pickAutoAssignee,
  workloadBalancingStrategy,
  type AutoAssignStrategy,
  type CandidateWorkload,
} from "@/lib/pure/assignment";
import type {
  AssignmentRequestBody,
  AutoAssignRequestBody,
  BulkAssignRequestBody,
  ReassignRequestBody,
} from "@/lib/schemas/assignment";

// ---------------------------------------------------------------------------
// Wire shapes (contracts.json — field names verbatim)
// ---------------------------------------------------------------------------

/** contracts.json models.AssignmentInfo — exact field names. */
export interface AssignmentInfo {
  id: string;
  applicationId: string;
  caseworkerUserId: string;
  caseworkerName: string;
  assignedByName?: string;
  method: AssignmentMethod;
  reason?: string;
  assignedAt: string;
  endedAt?: string;
  endReason?: string;
}

/** contracts.json models.AssignmentResult — exact field names. */
export interface AssignmentResult {
  applicationId: string;
  success: boolean;
  error?: string;
}

/** contracts.json models.BulkAssignResponse. */
export interface BulkAssignResponse {
  results: AssignmentResult[];
}

/** contracts.json models.AssignmentList. */
export interface AssignmentList {
  rows: AssignmentInfo[];
}

type AssignmentWithNames = CaseworkerAssignment & {
  caseworkerUser: { firstName: string; lastName: string };
  assignedByUser: { firstName: string; lastName: string } | null;
};

const NAME_SELECT = { select: { firstName: true, lastName: true } } as const;

function fullName(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim();
}

/** Serialize a row to the §A AssignmentInfo wire shape — names, never raw ids where the contract wants names. */
export function toAssignmentInfo(row: AssignmentWithNames): AssignmentInfo {
  const info: AssignmentInfo = {
    id: row.id,
    applicationId: row.applicationId,
    caseworkerUserId: row.caseworkerUserId,
    caseworkerName: fullName(row.caseworkerUser),
    method: row.method,
    assignedAt: row.assignedAt.toISOString(),
  };
  if (row.assignedByUser) info.assignedByName = fullName(row.assignedByUser);
  if (row.reason !== null) info.reason = row.reason;
  if (row.endedAt !== null) info.endedAt = row.endedAt.toISOString();
  if (row.endReason !== null) info.endReason = row.endReason;
  return info;
}

// ---------------------------------------------------------------------------
// Core primitive — one operation, one transaction
// ---------------------------------------------------------------------------

interface PerformAssignmentParams {
  /** Authenticated session user — the ONLY source of actor identity (audit integrity). */
  actor: SessionUser;
  applicationId: string;
  /** User.id receiving the assignment (= actor.userId for claim). */
  targetUserId: string;
  method: AssignmentMethod;
  reason: string | null;
  meta: RequestMetaBundle;
}

function invalidTarget(): HttpProblem {
  // VR-108 / INV-019 — the contract's validation error shape.
  return new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
    details: ["caseworkerUserId: must reference an active CASEWORKER-role user"],
  });
}

function holderConflict(method: AssignmentMethod, holderName: string): HttpProblem {
  // §4.4.1: a losing claimant sees "already claimed by [name]".
  const message =
    method === "claim"
      ? `Already claimed by ${holderName}`
      : `Already assigned to ${holderName}`;
  return new HttpProblem(409, ERROR_CODES.conflict, message);
}

/**
 * Execute one assignment operation atomically. Throws HttpProblem for every
 * contract-defined failure; maps a lost insert race (P2002 on the partial
 * unique index) to the contracted 409 naming the current holder.
 */
async function performAssignment(params: PerformAssignmentParams): Promise<AssignmentInfo> {
  const { actor, applicationId, targetUserId, method, reason, meta } = params;
  const now = new Date();

  try {
    const created = await prisma.$transaction(async (tx) => {
      const app = await tx.application.findUnique({
        where: { id: applicationId },
        select: { id: true, applicationNumber: true, workflowState: true },
      });
      if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

      // State gate (never mutated here — assignment ops never change workflowState).
      if (method === "claim" || method === "auto") {
        if (!CLAIMABLE_STATES.includes(app.workflowState)) {
          throw new HttpProblem(
            409,
            ERROR_CODES.conflict,
            "This application is not in a claimable state",
          );
        }
      } else if (app.workflowState === "draft" || TERMINAL_STATES.includes(app.workflowState)) {
        throw new HttpProblem(
          409,
          ERROR_CODES.conflict,
          "This application is not in an assignable state",
        );
      }

      // INV-019 transactional target check: active CASEWORKER only — except
      // Supervisor self-claim (claim with target === actor).
      const target = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, role: true, status: true, firstName: true, lastName: true },
      });
      if (method === "claim") {
        const selfClaim = target && target.id === actor.userId;
        const roleOk = target && (target.role === "CASEWORKER" || (target.role === "SUPERVISOR" && selfClaim));
        if (!target || !roleOk || target.status !== "active") {
          throw new HttpProblem(403, ERROR_CODES.forbidden, "You cannot claim this application");
        }
      } else if (!target || target.role !== "CASEWORKER" || target.status !== "active") {
        throw invalidTarget();
      }

      // Current holder (courtesy fast path — the partial unique index is the
      // race authority; a holder committed between this read and our insert
      // surfaces as P2002 below).
      const active = await tx.caseworkerAssignment.findFirst({
        where: { applicationId, endedAt: null },
        select: { id: true, caseworkerUserId: true, caseworkerUser: NAME_SELECT },
      });

      let priorHolder: { userId: string; name: string } | null = null;
      if (method === "reassign") {
        if (!active) {
          throw new HttpProblem(
            409,
            ERROR_CODES.conflict,
            "This application has no active assignment to reassign",
          );
        }
        if (active.caseworkerUserId === targetUserId) {
          throw holderConflict(method, fullName(active.caseworkerUser));
        }
        priorHolder = { userId: active.caseworkerUserId, name: fullName(active.caseworkerUser) };
        // Close the prior assignment (end timestamp + reason) — same transaction.
        await tx.caseworkerAssignment.update({
          where: { id: active.id },
          data: { endedAt: now, endReason: "reassigned" },
        });
      } else if (active) {
        // claim/manual/bulk/auto require an unassigned application (see module header).
        throw holderConflict(method, fullName(active.caseworkerUser));
      }

      const row = await tx.caseworkerAssignment.create({
        data: {
          applicationId,
          caseworkerUserId: targetUserId,
          assignedByUserId: actor.userId,
          method,
          reason,
          assignedAt: now,
        },
        include: { caseworkerUser: NAME_SELECT, assignedByUser: NAME_SELECT },
      });

      const targetName = fullName(target);

      // AUDIT (in-tx, all-or-nothing): who / what / when / why + before/after holder.
      await audit(tx, {
        actor: actor.userId,
        role: actor.role,
        actionType: "assignment",
        applicationId,
        entityType: "CaseworkerAssignment",
        entityId: row.id,
        summary: `Assignment (${method}) on application ${app.applicationNumber}: ${
          priorHolder ? priorHolder.name : "unassigned"
        } → ${targetName}`,
        before: { caseworkerUserId: priorHolder?.userId ?? null },
        after: { caseworkerUserId: targetUserId, method },
        reason,
        ip: meta.ip,
        requestId: meta.requestId,
      });

      // NOTIFICATIONS (§4.5.7): new caseworker on every method; previous
      // caseworker additionally on reassignment — via THE notification service
      // (task-036, §4.8.1 single-service mandate), in the same transaction.
      await createNotification(tx, {
        recipientUserId: targetUserId,
        type: "assignment",
        title: method === "claim" ? "Application claimed" : "New assignment",
        body:
          method === "claim"
            ? `You claimed application ${app.applicationNumber}.`
            : `Application ${app.applicationNumber} was assigned to you (${method})${
                reason ? `. Reason: ${reason}` : "."
              }`,
        applicationId,
      });
      if (priorHolder) {
        await createNotification(tx, {
          recipientUserId: priorHolder.userId,
          type: "assignment",
          title: "Application reassigned",
          body: `Application ${app.applicationNumber} was reassigned from you to ${targetName}. Reason: ${reason}`,
          applicationId,
        });
      }

      return row;
    });

    return toAssignmentInfo(created);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Lost the insert race on the partial unique index (INV-015): the DB
      // decided — report the winner as the contracted already-claimed-by 409.
      const winner = await prisma.caseworkerAssignment.findFirst({
        where: { applicationId, endedAt: null },
        select: { caseworkerUser: NAME_SELECT },
      });
      throw holderConflict(method, winner ? fullName(winner.caseworkerUser) : "another user");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * POST /api/applications/:id/claim — atomic claim from the unassigned queue.
 * Caseworker self-claim, or Supervisor self-claim (INV-019 exception).
 */
export async function claimApplication(
  user: SessionUser,
  applicationId: string,
  meta: RequestMetaBundle,
): Promise<AssignmentInfo> {
  return performAssignment({
    actor: user,
    applicationId,
    targetUserId: user.userId,
    method: "claim",
    reason: null,
    meta,
  });
}

/** POST /api/applications/:id/assignment — Supervisor manual assign. */
export async function manualAssign(
  user: SessionUser,
  applicationId: string,
  body: AssignmentRequestBody,
  meta: RequestMetaBundle,
): Promise<AssignmentInfo> {
  return performAssignment({
    actor: user,
    applicationId,
    targetUserId: body.caseworkerUserId,
    method: "manual",
    reason: body.reason?.trim() || null,
    meta,
  });
}

/** POST /api/applications/:id/reassignment — Supervisor reassign (required reason, both notified). */
export async function reassignApplication(
  user: SessionUser,
  applicationId: string,
  body: ReassignRequestBody,
  meta: RequestMetaBundle,
): Promise<AssignmentInfo> {
  return performAssignment({
    actor: user,
    applicationId,
    targetUserId: body.caseworkerUserId,
    method: "reassign",
    reason: body.reason.trim(),
    meta,
  });
}

/**
 * POST /api/supervisor/assignments/bulk — per-application results; one bad
 * application never fails the batch (each application = its own transaction +
 * audit entry). An invalid TARGET fails the whole request up front (VR-108
 * validation error) — it applies to every application identically.
 */
export async function bulkAssign(
  user: SessionUser,
  body: BulkAssignRequestBody,
  meta: RequestMetaBundle,
): Promise<BulkAssignResponse> {
  await requireActiveCaseworkerTarget(body.caseworkerUserId);
  const reason = body.reason?.trim() || null;

  const results: AssignmentResult[] = [];
  for (const applicationId of body.applicationIds) {
    results.push(
      await runToResult(applicationId, () =>
        performAssignment({
          actor: user,
          applicationId,
          targetUserId: body.caseworkerUserId,
          method: "bulk",
          reason,
          meta,
        }),
      ),
    );
  }
  return { results };
}

/**
 * POST /api/supervisor/assignments/auto — workload-balancing auto-assign
 * (§4.6.2, WALK-007) behind the strategy interface. Targets the given ids
 * (VR-113: each must be unassigned) or, when absent, every unassigned
 * application in a claimable state (the §4.4.1 Unassigned-queue definition),
 * oldest submission first. Per-application results; each success is its own
 * transaction + audit entry.
 */
export async function autoAssign(
  user: SessionUser,
  body: AutoAssignRequestBody,
  meta: RequestMetaBundle,
  strategy: AutoAssignStrategy = workloadBalancingStrategy,
): Promise<BulkAssignResponse> {
  // Productivity weighting config (§4.6.2: default off; w clamped to [0, 0.5]
  // by the pure formula).
  const options = {
    productivityAware: await getBooleanSetting("autoAssign.productivityAware"),
    productivityWeight: await getNumberSetting("autoAssign.productivityWeight"),
  };

  const applicationIds =
    body.applicationIds ??
    (
      await prisma.application.findMany({
        where: {
          workflowState: { in: [...CLAIMABLE_STATES] },
          assignments: { none: { endedAt: null } },
        },
        orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }],
        select: { id: true },
      })
    ).map((a) => a.id);

  // Live workload snapshot ONCE, then maintained in memory per assignment:
  // "at the moment of assignment" (§4.6.2) — after each success the winner's
  // activeCount is incremented and lastAssignedAt set, which is exactly what a
  // fresh recount would return (this loop is the only writer for these apps).
  const candidates = await buildCandidateWorkloads();

  const results: AssignmentResult[] = [];
  for (const applicationId of applicationIds) {
    const winnerId = pickAutoAssignee(candidates, options, strategy);
    if (winnerId === null) {
      results.push({ applicationId, success: false, error: "No active caseworkers available" });
      continue;
    }
    const result = await runToResult(applicationId, () =>
      performAssignment({
        actor: user,
        applicationId,
        targetUserId: winnerId,
        method: "auto",
        reason: null,
        meta,
      }),
    );
    if (result.success) {
      const winner = candidates.find((c) => c.userId === winnerId)!;
      winner.activeCount += 1;
      winner.lastAssignedAt = new Date();
    }
    results.push(result);
  }
  return { results };
}

/**
 * GET /api/applications/:id/assignments — full assignment history (supervisor
 * only, enforced by the route guard; §B: max 50, no pagination), newest first.
 */
export async function listAssignments(applicationId: string): Promise<AssignmentList> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true },
  });
  if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

  const rows = await prisma.caseworkerAssignment.findMany({
    where: { applicationId },
    orderBy: { assignedAt: "desc" },
    take: 50,
    include: { caseworkerUser: NAME_SELECT, assignedByUser: NAME_SELECT },
  });
  return { rows: rows.map(toAssignmentInfo) };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Whole-request target validation for bulk (VR-108 wording; INV-019 is re-checked in each tx). */
async function requireActiveCaseworkerTarget(userId: string): Promise<void> {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true },
  });
  if (!target || target.role !== "CASEWORKER" || target.status !== "active") {
    throw invalidTarget();
  }
}

/** Map one per-application operation to an AssignmentResult (partial success — batch never fails). */
async function runToResult(
  applicationId: string,
  op: () => Promise<AssignmentInfo>,
): Promise<AssignmentResult> {
  try {
    await op();
    return { applicationId, success: true };
  } catch (err) {
    if (err instanceof HttpProblem) {
      const detail = err.opts.details?.length ? ` (${err.opts.details.join("; ")})` : "";
      return { applicationId, success: false, error: `${err.message}${detail}` };
    }
    throw err;
  }
}

/**
 * Live candidate workloads for auto-assign (WALK-007). LIVE-STATE BUILDER:
 * every field is derived from the database at call time — nothing hardcoded.
 *
 *   activeCount     — active (endedAt null) assignments on non-terminal,
 *                     non-Draft applications (§4.6.2). "Terminal" here follows
 *                     the workflow contract: withdrawn / declined_by_borrower,
 *                     plus borrower_notified once an outcome is recorded
 *                     (INV-033: borrower_notified derives terminality from
 *                     outcome).
 *   lastAssignedAt  — most recent assignedAt across ALL the candidate's
 *                     assignments (tie-break input).
 *   completions90d  — applications with a final decision (decidedAt) in the
 *                     trailing 90 days where the candidate held the assignment
 *                     covering the decision moment (§4.4.2 "final decisions on
 *                     applications I held").
 */
export async function buildCandidateWorkloads(now: Date = new Date()): Promise<CandidateWorkload[]> {
  const caseworkers = await prisma.user.findMany({
    where: { role: "CASEWORKER", status: "active" },
    select: { id: true },
  });
  const ids = caseworkers.map((c) => c.id);
  if (ids.length === 0) return [];

  const activeRows = await prisma.caseworkerAssignment.findMany({
    where: {
      caseworkerUserId: { in: ids },
      endedAt: null,
      application: {
        workflowState: { notIn: ["draft", ...TERMINAL_STATES] },
        NOT: { workflowState: "borrower_notified", outcome: { not: null } },
      },
    },
    select: { caseworkerUserId: true },
  });
  const activeCounts = new Map<string, number>();
  for (const row of activeRows) {
    activeCounts.set(row.caseworkerUserId, (activeCounts.get(row.caseworkerUserId) ?? 0) + 1);
  }

  const lastAssigned = await prisma.caseworkerAssignment.groupBy({
    by: ["caseworkerUserId"],
    where: { caseworkerUserId: { in: ids } },
    _max: { assignedAt: true },
  });
  const lastAssignedAt = new Map<string, Date | null>(
    lastAssigned.map((g) => [g.caseworkerUserId, g._max.assignedAt]),
  );

  const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const decidedRows = await prisma.caseworkerAssignment.findMany({
    where: {
      caseworkerUserId: { in: ids },
      application: { decidedAt: { gte: since, lte: now } },
    },
    select: {
      caseworkerUserId: true,
      applicationId: true,
      assignedAt: true,
      endedAt: true,
      application: { select: { decidedAt: true } },
    },
  });
  // Count each (caseworker, application) at most once, and only when the
  // assignment interval covered the decision moment.
  const completed = new Map<string, Set<string>>();
  for (const row of decidedRows) {
    const decidedAt = row.application.decidedAt;
    if (!decidedAt) continue;
    const covers =
      row.assignedAt.getTime() <= decidedAt.getTime() &&
      (row.endedAt === null || row.endedAt.getTime() >= decidedAt.getTime());
    if (!covers) continue;
    let set = completed.get(row.caseworkerUserId);
    if (!set) {
      set = new Set();
      completed.set(row.caseworkerUserId, set);
    }
    set.add(row.applicationId);
  }

  return ids.map((userId) => ({
    userId,
    activeCount: activeCounts.get(userId) ?? 0,
    lastAssignedAt: lastAssignedAt.get(userId) ?? null,
    completions90d: completed.get(userId)?.size ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Deactivation close path (XBR-015, task-033)
// ---------------------------------------------------------------------------

/** endReason recorded when a staff deactivation closes an assignment (XBR-015). */
export const DEACTIVATION_END_REASON = "caseworker-deactivated";

/**
 * Close EVERY active assignment held by a caseworker being deactivated —
 * the same invariant path reassignment uses (endedAt + endReason on the
 * existing row; a NEW assignment is simply never created, so the applications
 * return to Unassigned). Runs on the CALLER's transaction client so the closes
 * commit atomically with the status flip, session revocation, notifications,
 * and audit entry (XBR-015). Workflow state is NEVER touched (WF-047:
 * "Deactivating/reassigning a caseworker never changes workflow state").
 *
 * Returns the applications whose assignment was closed (for the Supervisor
 * notification body + audit after-state).
 */
export async function closeAssignmentsForDeactivatedCaseworker(
  tx: AuditTransactionClient,
  caseworkerUserId: string,
): Promise<Array<{ applicationId: string; applicationNumber: string }>> {
  const active = await tx.caseworkerAssignment.findMany({
    where: { caseworkerUserId, endedAt: null },
    select: {
      id: true,
      applicationId: true,
      application: { select: { applicationNumber: true } },
    },
  });
  if (active.length === 0) return [];

  await tx.caseworkerAssignment.updateMany({
    where: { id: { in: active.map((row) => row.id) } },
    data: { endedAt: new Date(), endReason: DEACTIVATION_END_REASON },
  });

  return active.map((row) => ({
    applicationId: row.applicationId,
    applicationNumber: row.application.applicationNumber,
  }));
}
