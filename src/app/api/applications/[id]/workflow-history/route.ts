// GET /api/applications/:id/workflow-history — contracts §B: WorkflowHistoryPage
//   200 (borrower, caseworker, supervisor; 403/404). offset-limit (max 100).
//   WF-047, REQ-007, INV-036.
//
// RECORD-LEVEL SCOPING: borrower sees their OWN application's history only
// (non-owner → 404, no existence disclosure); caseworker needs full read access
// (active assignment — summary-level claimable access does not include history);
// supervisor full (S-4). S-6: WorkflowHistoryInfo carries actorDisplayName +
// actorRole only — staff USER IDS are never serialized (the wire shape has no
// id field for the actor; SYSTEM rows render as "System", never "unknown").

import { logged } from "@/lib/log";
import type { WorkflowHistory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { guard, canReadApplication } from "@/lib/guard";
import { forbidden, notFound, requestIdFrom } from "@/lib/http/errors";
import { getPagination, pageEnvelope } from "@/lib/http/pagination";
import { workflowStateLabel } from "@/lib/pure/workflow";

type HistoryRow = WorkflowHistory & {
  actorUser: { firstName: string; lastName: string } | null;
};

/** Serialize to the §A WorkflowHistoryInfo wire shape — exact field names. */
function toWorkflowHistoryInfo(row: HistoryRow): Record<string, unknown> {
  const actorDisplayName = row.actorUser
    ? `${row.actorUser.firstName} ${row.actorUser.lastName}`.trim()
    : row.actorRole === "SYSTEM"
      ? "System"
      : undefined;
  return {
    id: row.id,
    fromState: row.fromState,
    fromStateLabel: workflowStateLabel(row.fromState),
    toState: row.toState,
    toStateLabel: workflowStateLabel(row.toState),
    actorDisplayName,
    actorRole: row.actorRole,
    note: row.note ?? undefined,
    versionNumber: row.versionNumber ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId ?? requestIdFrom(request);

  const { id } = await params;
  const access = await canReadApplication(guarded.ctx.user, id);
  if (!access.allowed) {
    // Borrower probing another borrower's id: 404 — no existence disclosure.
    if (access.reason === "not-assigned") {
      return forbidden(requestId, "You are not assigned to this application");
    }
    return notFound(requestId, "Application not found");
  }
  if (access.level !== "full") {
    // S-2b summary-level claimable access covers QueueRow fields only.
    return forbidden(requestId, "Claim this application to view its workflow history");
  }

  const pagination = await getPagination(request, 100);
  const [rows, total] = await Promise.all([
    prisma.workflowHistory.findMany({
      where: { applicationId: id },
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      include: { actorUser: { select: { firstName: true, lastName: true } } },
    }),
    prisma.workflowHistory.count({ where: { applicationId: id } }),
  ]);

  return Response.json(
    pageEnvelope(rows.map((row) => toWorkflowHistoryInfo(row)), pagination, total),
    { status: 200 },
  );
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
