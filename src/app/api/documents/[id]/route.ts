// DELETE /api/documents/:id — contracts §B: 204 (borrower; 403, 404, 409).
//   Owner + Draft state only; removes the document, ALL versions, and their
//   storage objects, audited (§4.2.9, REQ-038, NFR-013, INV-007, INV-027).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { deleteDocument } from "@/lib/services/document";

async function DELETE_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    await deleteDocument(guarded.ctx.user, id, requestMeta(request));
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const DELETE = logged(DELETE_impl);
