// GET /api/applications/:id/fraud-flags — contracts §B: FraudFlagList 200
//   (caseworker, supervisor; 403/404; pagination "none (max 50)"). Fraud flags
//   listed on the staff detail page (task-027, REQ-060, §4.6.6).
//
// RECORD-LEVEL SCOPING: a caseworker must hold the current ACTIVE assignment on
// the application (S-2a) — summary-level queue visibility never exposes fraud
// detail; supervisors read everything (S-4). Enforced in listFraudFlags.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { listFraudFlags } from "@/lib/services/fraud";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const list = await listFraudFlags(guarded.ctx.user, id);
    return Response.json(list, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
