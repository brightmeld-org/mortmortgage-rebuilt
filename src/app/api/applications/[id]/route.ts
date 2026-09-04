// GET    /api/applications/:id — contracts §B: Application 200 (borrower,
//   caseworker, supervisor; 401, 403, 404). REQ-049/REQ-002/REQ-005/NFR-003.
// DELETE /api/applications/:id — contracts §B: 204 (borrower; 403, 404, 409).
//   Draft only, audited in-transaction (REQ-020, INV-027).
//
// RECORD-LEVEL SCOPING: reads go through canReadApplication (borrower own /
// assigned caseworker / supervisor); delete through requireBorrowerOwnedAction.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { deleteDraft, getApplicationWire } from "@/lib/services/application";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const application = await getApplicationWire(guarded.ctx.user, id);
    return Response.json(application);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

async function DELETE_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    await deleteDraft(guarded.ctx.user, id, requestMeta(request));
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
export const DELETE = logged(DELETE_impl);
