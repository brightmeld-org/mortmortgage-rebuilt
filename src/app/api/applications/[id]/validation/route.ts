// GET /api/applications/:id/validation — contracts §B: ValidationSummary 200
//   (borrower; 403, 404). REQ-036/REQ-033.
//
// Computed by THE pure validation engine (src/lib/pure/urla-validation.ts) over
// live rows + live thresholds — the same authority the T1/T36 gate enforces.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getValidationSummary } from "@/lib/services/application";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const summary = await getValidationSummary(guarded.ctx.user, id);
    return Response.json(summary);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
