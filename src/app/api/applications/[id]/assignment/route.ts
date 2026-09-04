// POST /api/applications/:id/assignment — contracts §B: AssignmentRequest ->
//   AssignmentInfo 201 (supervisor only; validation error/403/404/409).
//   Supervisor manual assign (task-022, REQ-056, NFR-005, VR-108/VR-109,
//   INV-015, INV-019).
//
// Guard runs FIRST, then the strict schema; the service verifies the target is
// an active CASEWORKER inside the transaction and the DB partial unique index
// decides concurrent races (409 naming the current holder).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { assignmentRequestSchema } from "@/lib/schemas/assignment";
import { manualAssign } from "@/lib/services/assignment";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, assignmentRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const info = await manualAssign(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(info, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
