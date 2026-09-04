// GET /api/applications/:id/checks — contracts §B: UnderwritingResultList 200
//   (caseworker, supervisor; 403, 404). Pagination: none (max 25).
//
// REQ-059. Rows are newest-first; the current result per check type
// (supersededById = null) is always included, history fills to the 25-row cap.
//
// RECORD-LEVEL SCOPING: FULL read access required — an unassigned
// caseworker's S-2b summary view does not include underwriting results.
//
// The lazy ASYNC-005 reconciler runs first, so a row stuck in `running`
// (crash mid-execution) surfaces as errored-with-Retry on the next read.

import { logged } from "@/lib/log";
import { guard, canReadApplication } from "@/lib/guard";
import { forbidden, notFound, requestIdFrom } from "@/lib/http/errors";
import {
  listUnderwritingResults,
  reconcileStuckUnderwritingChecks,
} from "@/lib/services/underwriting-checks";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId ?? requestIdFrom(request);

  const { id } = await params;
  const access = await canReadApplication(guarded.ctx.user, id);
  if (!access.allowed) {
    if (access.reason === "not-assigned") {
      return forbidden(requestId, "You are not assigned to this application");
    }
    return notFound(requestId, "Application not found");
  }
  if (access.level !== "full") {
    return forbidden(requestId, "Claim this application to view its underwriting checks");
  }

  await reconcileStuckUnderwritingChecks(id);
  return Response.json(await listUnderwritingResults(id), { status: 200 });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
