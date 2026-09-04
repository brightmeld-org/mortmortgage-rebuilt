// POST /api/applications/:id/corrections — contracts §B: CorrectionRequest ->
//   CorrectionInfo 201 (caseworker, supervisor; validation error, 403, 404, 409).
// GET  /api/applications/:id/corrections — contracts §B: CorrectionPage 200
//   (caseworker, supervisor; 403, 404). offset-limit pagination (max 100).
//
// REQ-050, NFR-007 (SEC-6), NFR-008, VR-089..VR-092, XBR-004, INV-030, AC-25.
//
// RECORD-LEVEL SCOPING: the roleGate (caseworker/supervisor — borrowers 403
// before any body parsing) is only the route gate; the service enforces the
// SEC-6 record rule (active assignment or Supervisor) via canWriteApplication,
// and the GET requires FULL read access (an unassigned caseworker's S-2b
// summary view does not include correction provenance).

import { logged } from "@/lib/log";
import { guard, canReadApplication } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { forbidden, notFound, HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { getPagination } from "@/lib/http/pagination";
import { correctionRequestSchema } from "@/lib/schemas/corrections";
import { listCorrections, recordCorrection } from "@/lib/services/corrections";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, correctionRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const info = await recordCorrection(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(info, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

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
    // S-2b summary-level claimable access covers QueueRow fields only.
    return forbidden(requestId, "Claim this application to view its corrections");
  }

  const pagination = await getPagination(request, 100);
  return Response.json(await listCorrections(id, pagination), { status: 200 });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
export const GET = logged(GET_impl);
