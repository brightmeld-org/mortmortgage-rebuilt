// GET /api/documents/:id/ocr — contracts §B: no body -> OcrPanelResponse 200
//   (caseworker, supervisor; 403, 404). REQ-067, INT-008, XBR-016.
//
// Latest DocumentJob + latest OcrExtraction for the document's CURRENT version
// (both optional — a running job has no extraction yet). Poll-friendly: the
// staff panel (task-035) polls this endpoint for live job status.
//
// RECORD-LEVEL SCOPING: roleGate is only the gate; the service requires the
// caseworker to hold the ACTIVE assignment (403), supervisors read everything,
// and unknown/unowned ids are 404 with no existence disclosure.
//
// Lazy scheduler pass (ASYNC-001/004): each poll hands one bounded
// runDueDocumentJobs() pass to `after()` — stuck jobs are reconciled (10-min
// rule) and due automatic retries requeued/processed without blocking the
// response. The durable boot/scheduled wiring is task-045.
//
// Importing the service transitively loads src/lib/services/ocr — the §6.1
// fail-fast provider-config validation runs at module load.

import { logged } from "@/lib/log";
import { after } from "next/server";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getOcrPanel, runDueDocumentJobs } from "@/lib/services/document-ocr";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId ?? requestIdFrom(request);

  const { id } = await params;
  try {
    const panel = await getOcrPanel(guarded.ctx.user, id);
    after(() =>
      runDueDocumentJobs().catch((err) => console.error("document-ocr scheduler pass failed", err)),
    );
    return Response.json(panel);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
