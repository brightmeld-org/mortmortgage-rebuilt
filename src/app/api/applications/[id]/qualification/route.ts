// GET /api/applications/:id/qualification — contracts §B: QualificationSummary
//   200 (caseworker, supervisor; 403, 404).
//
// REQ-059, NFR-008, AC-13: dti/ltv/cltv come from THE shared qualification
// module (computeApplicationQualification) — identical values to every other
// consumer; credit/pricing/AUS card fields from the current completed
// underwriting results; escalation from the live task-020 evaluation.
//
// RECORD-LEVEL SCOPING: FULL read access required (S-2b summary view has no
// qualification detail).

import { logged } from "@/lib/log";
import { guard, canReadApplication } from "@/lib/guard";
import { forbidden, notFound, requestIdFrom } from "@/lib/http/errors";
import { getQualificationSummary } from "@/lib/services/underwriting-checks";

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
    return forbidden(requestId, "Claim this application to view its qualification summary");
  }

  return Response.json(await getQualificationSummary(id), { status: 200 });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
