// GET /api/applications/:id/assignments — contracts §B: AssignmentList 200
//   (supervisor only; 403/404; max 50 rows, no pagination params).
//   Assignment history for the supervisor detail view (task-022, REQ-058).
//
// Supervisors have full read on every application (S-4), so the role gate IS
// the record-level scope here; the service still 404s a missing application.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { listAssignments } from "@/lib/services/assignment";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const list = await listAssignments(id);
    return Response.json(list, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
