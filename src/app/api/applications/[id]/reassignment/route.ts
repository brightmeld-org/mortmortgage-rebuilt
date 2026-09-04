// POST /api/applications/:id/reassignment — contracts §B: ReassignRequest ->
//   AssignmentInfo 201 (supervisor only; validation error/403/404/409).
//   Supervisor reassign (task-022, REQ-056, NFR-005, VR-114/VR-115, INV-015,
//   INV-019): required reason, closes the prior assignment and creates the new
//   one in ONE transaction, notifies BOTH caseworkers.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { reassignRequestSchema } from "@/lib/schemas/assignment";
import { reassignApplication } from "@/lib/services/assignment";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, reassignRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const info = await reassignApplication(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(info, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
