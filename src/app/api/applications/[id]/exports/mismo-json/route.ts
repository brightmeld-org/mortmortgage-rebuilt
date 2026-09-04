// GET /api/applications/:id/exports/mismo-json — contracts §B (task-040):
//   (no body) -> streamed MISMO v3.4 JSON document 200 (supervisor; errors
//   403, 404, 409 [401 via guard]); query `?full=true&reason=<text>` for the
//   audited Supervisor full-SSN export, default masked.
//
// REQ-072 / REQ-073 / DATA-002 / RFP §4.9.1 / ASM-010 / INV-037.
//
// - Supervisor roleGate via the single shared guard (INV-038); the shared
//   export gate (task-040 plumbing) answers 404 unknown id / 409 Draft.
// - Boundary validation FIRST (full/reason — export-gate), then the gate,
//   then ONE bounded application-graph load through the shared masked loader
//   (SEC-14 note: per-application exports are bounded by design).
// - SSN masked (***-**-NNNN) by default; full=true&reason= decrypts to
//   NNN-NN-NNNN — the ONLY unmasked SSN egress among exports.
// - Individually audited BEFORE the body is produced (task-039 precedent):
//   actionType "export", kind export_mismo_json, actor from the session,
//   params in `after`, the Supervisor's reason on full-SSN exports.
// - File-stream download convention: attachment Content-Disposition (§B).
//   The document derives entirely from live loaded rows (LIVE-STATE rule);
//   conformance is validated against src/lib/services/exports/mismo-mapping.ts.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { auditExport } from "@/lib/services/exports/audited-export";
import {
  parseFullSsnParams,
  requireExportableApplication,
} from "@/lib/services/exports/export-gate";
import { loadApplicationExportData } from "@/lib/services/exports/application-export-data";
import { buildMismoDocument, mismoJson } from "@/lib/services/exports/mismo";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;
  const { id } = await params;

  try {
    const exportParams = parseFullSsnParams(request);
    const app = await requireExportableApplication(id);
    const data = await loadApplicationExportData(id, { fullSsn: exportParams.full });

    // Individual audit row BEFORE any response bytes (REQ-072, SEC-8).
    await auditExport({
      user,
      kind: "export_mismo_json",
      applicationId: app.id,
      summary: `MISMO v3.4 JSON exported for application ${app.applicationNumber}${
        exportParams.full ? " with full SSN" : " (SSN masked)"
      }`,
      params: { format: "json", full: exportParams.full },
      reason: exportParams.reason,
      meta: requestMeta(request),
    });

    const body = mismoJson(buildMismoDocument(data));
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="mismo-${app.applicationNumber}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof HttpProblem) return problemResponse(error, requestId);
    throw error;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
