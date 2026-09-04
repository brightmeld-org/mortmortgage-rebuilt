// POST /api/supervisor/assignments/auto — contracts §B: AutoAssignRequest ->
//   BulkAssignResponse 200 (supervisor only; validation error/403).
//   Workload-balancing auto-assign (task-022, REQ-056, VR-113, WALK-007,
//   §4.6.2) behind the strategy interface (src/lib/pure/assignment.ts), with
//   optional productivity-aware weighting from SystemConfig.
//
// Per-application results; each successful assignment runs in its own
// transaction with its own audit entry.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { autoAssignRequestSchema } from "@/lib/schemas/assignment";
import { autoAssign } from "@/lib/services/assignment";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, autoAssignRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const response = await autoAssign(guarded.ctx.user, parsed.data, requestMeta(request));
    return Response.json(response, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
