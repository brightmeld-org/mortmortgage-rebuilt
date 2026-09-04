// POST /api/applications/:id/transition — contracts §B: TransitionRequest ->
//   Application 200 (borrower, caseworker, supervisor; 403/404/409/validation
//   error). The whitelist transition engine (task-019) — §A map, WF-047,
//   INV-033, VR-078..082.
//
// RECORD-LEVEL SCOPING + actor rules live in the engine
// (src/lib/services/workflow-engine.ts): B = owning borrower only (staff incl.
// supervisors 403 on borrower-only transitions, INV-027), C = active assignment
// required, decision transitions 409 → approval-decision endpoint, T27/T28
// SYS-only 409. Guard + strict schema run before any state read.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { transitionRequestSchema } from "@/lib/schemas/transition";
import { executeTransition } from "@/lib/services/workflow-engine";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, transitionRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const application = await executeTransition(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(application, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
