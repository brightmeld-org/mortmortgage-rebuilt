// POST /api/documents/:id/ocr/apply-suggestion — contracts §B:
//   ApplySuggestionRequest -> CorrectionInfo 200
//   (caseworker, supervisor; validation error, 403, 404, 409).
// REQ-067, NFR-017 (SEC-16), NFR-007 (SEC-6), XBR-018, AC-45.
//
// SERVER-AUTHORITATIVE: the service composes the SAME gates as
// POST /api/applications/:id/corrections (active assignment or Supervisor,
// the five staff-editable states, target-field schema validation) via
// recordCorrection — never re-derived here — and records the correction with
// the source document in the audit envelope (SEC-16 provenance). Actor
// identity comes from the SESSION only (audit-integrity rule).
//
// RECORD-LEVEL SCOPING: roleGate is only the gate; the service requires the
// caseworker to hold the ACTIVE assignment (403), supervisors act on
// everything, and unknown/unowned document or extraction ids are 404 with no
// existence disclosure.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { applySuggestionRequestSchema } from "@/lib/schemas/ocr";
import { applyOcrSuggestion } from "@/lib/services/ocr-suggestions";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId ?? requestIdFrom(request);

  const { id } = await params;
  const parsed = await parseBody(request, applySuggestionRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const info = await applyOcrSuggestion(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(info, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
