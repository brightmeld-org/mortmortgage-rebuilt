// POST /api/applications/:id/checks/:checkType — contracts §B: no body ->
//   UnderwritingResultInfo 202 (caseworker, supervisor; 403, 404, 409).
//
// REQ-059, NFR-022, INT-001..005, INT-010, INT-013..016, INT-021, SEC-21,
// INV-030/031, ASYNC-005, XBR-022.
//
// 202 semantics (ASYNC-005): the response carries the RUNNING
// UnderwritingResult created before any provider work; execution (provider
// call + configured latency + completion recording + audit) continues after
// the response via next/server `after()`. A duplicate request while the same
// check is in flight is "ignored server-side" (§4.6.5): it receives 202 with
// the EXISTING running row — the DB partial unique index (INV-031) decides,
// never check-then-act.
//
// RECORD-LEVEL SCOPING: roleGate (caseworker/supervisor) is only the route
// gate; the service enforces SEC-21 (states 3-8 → 409; active assignment or
// Supervisor → 403 otherwise; unknown application → 404).
//
// Importing the checks service transitively loads src/lib/services/checks —
// the INT-001 fail-fast provider-config validation runs at module load, so a
// misconfigured real provider stops this route from booting at all.

import { logged } from "@/lib/log";
import { after } from "next/server";
import { guard } from "@/lib/guard";
import { HttpProblem, notFound, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import type { CheckType } from "@prisma/client";
import { CHECK_TYPE_VALUES, startUnderwritingCheck } from "@/lib/services/underwriting-checks";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string; checkType: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId ?? requestIdFrom(request);

  const { id, checkType } = await params;
  // Path-segment validation against the CheckType enum: an unknown segment is
  // an endpoint that does not exist in the contract → 404.
  if (!(CHECK_TYPE_VALUES as readonly string[]).includes(checkType)) {
    return notFound(requestId, "Unknown check type");
  }

  try {
    const result = await startUnderwritingCheck(
      guarded.ctx.user,
      id,
      checkType as CheckType,
      requestMeta(request),
    );
    if (result.execution) {
      // Keep the serverless context alive until the async execution records
      // its outcome — the 202 below returns first (ASYNC-005).
      const execution = result.execution;
      after(() => execution);
    }
    return Response.json(result.info, { status: 202 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
