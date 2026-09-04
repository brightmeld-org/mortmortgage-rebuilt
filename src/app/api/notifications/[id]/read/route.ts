// POST /api/notifications/:id/read — contracts §B: NotificationInfo 200
// (roleGate ["authenticated-any"]; 401, 404). REQ-070, task-036.
//
// Record-level scoping: only the recipient may mark their row; anyone else's
// id resolves 404 (no existence disclosure). Idempotent on re-read.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { markNotificationRead } from "@/lib/services/notifications";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const info = await markNotificationRead(guarded.ctx.user, id);
    return Response.json(info, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
