// POST /api/applications/:id/decision-notification/retry — contracts §B:
// Application 200 (roleGate ["caseworker", "supervisor"]; 403, 404, 409).
// WF-049 / WF-033 / WF-034 / REQ-068, ASYNC-003 staff retry. task-036.
//
// Re-drives the SOLE T27/T28 executor (executeDecisionDispatch) for an
// application flagged decisionNotificationPending. Record-level scoping inside
// the service: caseworker must hold the active assignment (S-3); supervisors
// full (S-4). The retry action is audited; on success the application returns
// as borrower_notified, on a still-failing dispatch it stays approved/denied
// with the pending indicator.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { retryDecisionNotification } from "@/lib/services/decision-dispatch";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const application = await retryDecisionNotification(guarded.ctx.user, id, {
      ...requestMeta(request),
    });
    return Response.json(application, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
