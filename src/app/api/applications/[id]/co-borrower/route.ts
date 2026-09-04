// POST   /api/applications/:id/co-borrower — contracts §B: Application 201
//   (borrower; 403, 404, 409). Max one co-borrower (INV-035).
// DELETE /api/applications/:id/co-borrower — contracts §B: Application 200
//   (borrower; 403, 404, 409). REQ-034, INV-027.
//
// Draft / Revision Requested only; audited co-borrower-add / co-borrower-remove
// in the same transaction; removal deletes the co-borrower's data + signatures
// and invalidates remaining signatures (data changed — XBR-003).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { addCoBorrower, removeCoBorrower } from "@/lib/services/application";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const application = await addCoBorrower(guarded.ctx.user, id, requestMeta(request));
    return Response.json(application, { status: 201 });
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
    const application = await removeCoBorrower(guarded.ctx.user, id, requestMeta(request));
    return Response.json(application);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
export const DELETE = logged(DELETE_impl);
