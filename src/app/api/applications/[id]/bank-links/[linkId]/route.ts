// DELETE /api/applications/:id/bank-links/:linkId — contracts §B: Application
// 200 (borrower; 403, 404). REQ-039, XBR-019, §4.2.10.
//
// Unlink: owner-only (INV-027 — staff → 403, non-owner/unknown/foreign linkId
// → 404), borrower-editable states only (wrong state → 403; §B declares no
// 409 — documented resolution in src/lib/services/bank-link.ts), encrypted
// token REMOVED, imported asset rows flipped to source manual (rows retained),
// signatures invalidated + ratios recalculated when data changed,
// `bank-unlink` audited in-transaction. Returns the full Application.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { unlinkBankLink } from "@/lib/services/bank-link";

async function DELETE_impl(
  request: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id, linkId } = await params;
  try {
    const application = await unlinkBankLink(guarded.ctx.user, id, linkId, requestMeta(request));
    return Response.json(application);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const DELETE = logged(DELETE_impl);
