// POST /api/notifications/:id/retry — contracts §B: NotificationInfo 200
// (roleGate ["supervisor"]; 403, 404, 409). REQ-068, INT-009, ASM-009 manual
// retry after automatic retries are exhausted. task-036.
//
// Staff mutation → audited (actionType "notification-retry", session actor).
// The response reflects the fresh outcome of the immediate re-attempt.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { retryNotificationDelivery } from "@/lib/services/notifications";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const info = await retryNotificationDelivery(guarded.ctx.user, id, requestMeta(request));
    return Response.json(info, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
