// GET /api/applications/:id/exports/urla-pdf — contracts §B (task-041):
//   (no body) -> streamed URLA 2020 (Form 1003) PDF 200 (supervisor; errors
//   403, 404, 409 [401 via guard]). REQ-072 / REQ-075 / RFP §4.9.3.
//
// - Supervisor roleGate via the single shared guard (INV-038); the shared
//   export gate (task-040 plumbing) answers 404 unknown id / 409 Draft.
// - SSN is ALWAYS masked to last four — this endpoint has no full-SSN mode
//   (contracts §B declares ?full only on the MISMO exports); the loader runs
//   with fullSsn: false and the PDF prints the wire ssnMasked.
// - ONE bounded application-graph load through the shared masked loader
//   (SEC-14: per-application exports are bounded by design).
// - Individually audited BEFORE any body bytes (task-039/040 precedent):
//   actionType "export", kind export_urla_pdf, actor from the session only.
// - File-stream download convention: attachment Content-Disposition (§B).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { auditExport } from "@/lib/services/exports/audited-export";
import { requireExportableApplication } from "@/lib/services/exports/export-gate";
import { loadApplicationExportData } from "@/lib/services/exports/application-export-data";
import { buildUrlaPdf } from "@/lib/services/exports/urla-pdf";
import { getCompanyTimeZone } from "@/lib/services/sla";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;
  const { id } = await params;

  try {
    const app = await requireExportableApplication(id);
    const data = await loadApplicationExportData(id, { fullSsn: false });
    // INV-045: the company zone is resolved at call time, never a constant.
    const pdf = buildUrlaPdf(data, await getCompanyTimeZone());

    // Individual audit row BEFORE any response bytes (REQ-072, SEC-8).
    await auditExport({
      user,
      kind: "export_urla_pdf",
      applicationId: app.id,
      summary: `URLA 2020 PDF exported for application ${app.applicationNumber} (SSN masked)`,
      params: { format: "pdf", pageCount: pdf.pageCount, borrowers: data.borrowers.length },
      meta: requestMeta(request),
    });

    return new Response(new Uint8Array(pdf.bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.bytes.length),
        "content-disposition": `attachment; filename="urla-${app.applicationNumber}.pdf"`,
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
