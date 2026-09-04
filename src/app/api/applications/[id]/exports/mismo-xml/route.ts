// GET /api/applications/:id/exports/mismo-xml — contracts §B (task-040):
//   (no body) -> streamed MISMO v3.4 XML document 200 (supervisor; errors
//   403, 404, 409 [401 via guard]); query `?full=true&reason=<text>` for the
//   audited Supervisor full-SSN export, default masked.
//
// REQ-072 / REQ-074 / DATA-002 / RFP §4.9.2 / ASM-010 / INV-037.
//
// - Equivalent structure by construction: the SAME buildMismoDocument tree as
//   the JSON export, emitted as well-formed UTF-8 XML in the MISMO namespace
//   http://www.mismo.org/residential/2009/schemas with the same masking rules.
// - Supervisor guard + shared export gate (404 unknown / 409 Draft) + shared
//   masked loader + shared audited-export wrapper — see the mismo-json route
//   header for the shared semantics; only the emitter differs here.

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
import { buildMismoDocument, mismoXml } from "@/lib/services/exports/mismo";

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
      kind: "export_mismo_xml",
      applicationId: app.id,
      summary: `MISMO v3.4 XML exported for application ${app.applicationNumber}${
        exportParams.full ? " with full SSN" : " (SSN masked)"
      }`,
      params: { format: "xml", full: exportParams.full },
      reason: exportParams.reason,
      meta: requestMeta(request),
    });

    const body = mismoXml(buildMismoDocument(data));
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "content-disposition": `attachment; filename="mismo-${app.applicationNumber}.xml"`,
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
