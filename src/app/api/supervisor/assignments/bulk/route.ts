// POST /api/supervisor/assignments/bulk — contracts §B: BulkAssignRequest ->
//   BulkAssignResponse 200 (supervisor only; validation error/403).
//   Supervisor bulk assign (task-022, REQ-056, VR-110..112, INV-015, INV-019).
//
// Per-application results — partial success is expected and one bad
// application never fails the batch; each successful assignment runs in its
// own transaction with its own audit entry. An invalid target caseworker is a
// whole-request validation error (it applies to every application).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { bulkAssignRequestSchema } from "@/lib/schemas/assignment";
import { bulkAssign } from "@/lib/services/assignment";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, bulkAssignRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const response = await bulkAssign(guarded.ctx.user, parsed.data, requestMeta(request));
    return Response.json(response, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
