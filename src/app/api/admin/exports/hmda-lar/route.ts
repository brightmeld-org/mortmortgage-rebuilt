// GET /api/admin/exports/hmda-lar — contracts §B (task-042):
//   `?year=YYYY` (REQUIRED) -> streamed pipe-delimited FFIEC HMDA LAR file
//   200 (supervisor; errors 403, 409, validation error [401 via guard]).
//   409 until BOTH hmda.lei and hmda.agencyCode SystemConfig values are set.
//
// REQ-072 / REQ-076 / DATA-003 / NFR-015 / RFP §4.9.4 / ASM-005 / ASM-010.
//
// - Supervisor roleGate via the single shared guard (INV-038).
// - Boundary validation FIRST (year — 400), then the config gate (409), then
//   the individual audit row BEFORE any response bytes (task-039/040
//   precedent: actionType "export", kind export_hmda_lar, actor from the
//   session, params in `after`).
// - Body is a STREAMED text file (SEC-14 / WALK-005): keyset-cursor batches
//   folded into the ReadableStream chunk-by-chunk — never JSON, never a
//   full-set memory load. Content-Disposition: attachment (§B).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { auditExport } from "@/lib/services/exports/audited-export";
import {
  larByteStream,
  parseLarYear,
  requireHmdaConfig,
} from "@/lib/services/exports/hmda-lar";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;

  try {
    const year = parseLarYear(request);
    const cfg = await requireHmdaConfig();

    // Individual audit row BEFORE any response bytes (REQ-072, SEC-8).
    await auditExport({
      user,
      kind: "export_hmda_lar",
      applicationId: null,
      summary: `HMDA LAR exported for calendar year ${year}`,
      params: { year },
      meta: requestMeta(request),
    });

    return new Response(larByteStream(year, cfg), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="hmda-lar-${year}.txt"`,
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
