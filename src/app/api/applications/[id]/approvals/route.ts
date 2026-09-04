// GET /api/applications/:id/approvals — contracts §B: ApprovalList 200
//   (caseworker, supervisor; 403/404). No pagination (max 25) — task-020.
//
// RECORD-LEVEL SCOPING: caseworkers need the current ACTIVE assignment (S-2a);
// the unassigned summary level never exposes decision detail. approverName /
// clearedByName are display names only (S-6).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { listApprovals } from "@/lib/services/approval";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const list = await listApprovals(guarded.ctx.user, id);
    return Response.json(list, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
