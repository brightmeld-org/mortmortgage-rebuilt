// Supervisor priority override service (task-021) — REQ-057, RFP §4.6.3
// ("Set priority override; ... audited and notifies the assigned caseworker").
//
// PATCH /api/applications/:id/priority semantics (contracts §B): supervisor
// only (route guard); PriorityRequest { priority, reason? } → §A Application
// 200; 400 (VR-116 enum / VR-117 reason ≤ 500) / 403 / 404. The endpoint table
// lists NO 409 and PriorityRequest carries no versionStamp — this write does
// not participate in the optimistic-concurrency stamp; it is still atomic
// (single $transaction: read → update → audit → notify, all-or-nothing).
//
// ADMIN-ENDPOINT INVARIANT: mutates priority/priorityOverride ONLY — never
// workflowState — and never bypasses audit (audit insert is in-transaction;
// its failure rolls the override back).
//
// Once priorityOverride=true, the automatic rules never overwrite the value
// (src/lib/services/sla.ts refreshAutomaticPriority is override-pinned).

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
import type { PriorityRequestBody } from "@/lib/schemas/priority";

/**
 * Apply a Supervisor priority override: sets priority + priorityOverride=true,
 * audits before/after (+ reason) and notifies the assigned caseworker (if any)
 * in ONE transaction. `user` MUST be the guard's authenticated session user
 * (audit integrity — actor identity never comes from the body); the route's
 * roleGate admits supervisors only. Returns the serialized §A Application with
 * live SLA fields.
 */
export async function setPriorityOverride(
  user: SessionUser,
  applicationId: string,
  body: PriorityRequestBody,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  await prisma.$transaction(async (tx) => {
    // CHECK-THEN-ACT inside the transaction: existence check (404 — the
    // supervisor-only endpoint still verifies the record) + before-image read.
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: {
        id: true,
        applicationNumber: true,
        priority: true,
        priorityOverride: true,
        assignments: { where: { endedAt: null }, select: { caseworkerUserId: true }, take: 1 },
      },
    });
    if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

    await tx.application.update({
      where: { id: applicationId },
      data: { priority: body.priority, priorityOverride: true },
    });

    // §4.6.3: overrides are audited — before/after + operator reason, in-tx.
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "priority-override",
      applicationId: app.id,
      entityType: "Application",
      entityId: app.id,
      summary: `Priority override on application ${app.applicationNumber}: ${app.priority} → ${body.priority}`,
      before: { priority: app.priority, priorityOverride: app.priorityOverride },
      after: { priority: body.priority, priorityOverride: true },
      reason: body.reason?.trim() || null,
      ip: meta.ip,
      requestId: meta.requestId,
    });

    // §4.6.3: notify the assigned caseworker — via THE notification service
    // (task-036, §4.8.1 single-service mandate), in the same transaction.
    const caseworkerUserId = app.assignments[0]?.caseworkerUserId;
    if (caseworkerUserId) {
      await createNotification(tx, {
        recipientUserId: caseworkerUserId,
        type: "priority-override",
        title: "Priority changed",
        body: `A supervisor set the priority of application ${app.applicationNumber} to ${body.priority}.`,
        applicationId: app.id,
      });
    }
  });

  const row = await prisma.application.findUnique({
    where: { id: applicationId },
    include: APPLICATION_INCLUDE,
  });
  if (!row) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  return withSlaFields(
    serializeApplication(row as ApplicationWithRelations, user.role),
    row as unknown as SlaEnrichableRow,
  );
}
