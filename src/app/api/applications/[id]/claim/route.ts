// POST /api/applications/:id/claim — contracts §B: no body -> AssignmentInfo
//   201 (caseworker, supervisor; 403/404/409). Atomic claim from the
//   unassigned queue (task-022, REQ-047, NFR-005, SEC-4, INV-015, AC-24).
//
// Guard runs FIRST (roleGate + CSRF), then the service claims for the SESSION
// user only (Supervisor self-claim permitted — INV-019; actor identity never
// comes from a request body). Losing a race returns the contracted 409
// "Already claimed by [name]" — the DB partial unique index decides.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { claimApplication } from "@/lib/services/assignment";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const info = await claimApplication(guarded.ctx.user, id, requestMeta(request));
    return Response.json(info, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
