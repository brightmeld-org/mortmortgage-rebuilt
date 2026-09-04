// POST /api/conditions/:id/clear — contracts §B: ConditionInfo 200
//   (caseworker, supervisor; 403/404/409). Per-condition clear (task-020,
//   WF-036, XBR-011, REQ-054).
//
// RECORD-LEVEL SCOPING: a caseworker must hold the current ACTIVE assignment on
// the OWNING application; already-cleared → 409; clearing notifies the
// caseworker and is audited in the same transaction. The T30 all-cleared gate
// lives in the transition engine (task-019) and reads these rows live.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { clearCondition } from "@/lib/services/approval";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const condition = await clearCondition(guarded.ctx.user, id, requestMeta(request));
    return Response.json(condition, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
