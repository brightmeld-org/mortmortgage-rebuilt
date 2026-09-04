// GET /api/caseworker/stats — contracts §B: CaseworkerStats 200 (caseworker
// ONLY; 401, 403). REQ-048. Task-028.
//
// Figures are derived from the SESSION caseworker's live assignments/decisions
// (record-level scoping — never a client-supplied id).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { caseworkerStats } from "@/lib/services/queue";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker"] });
  if (!guarded.ok) return guarded.response;

  try {
    const stats = await caseworkerStats(guarded.ctx.user);
    return Response.json(stats);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
