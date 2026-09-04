// GET /api/admin/exports/warehouse — contracts §B (task-042):
//   `?mode=full|incremental&since=<ISO>` (`since` required for incremental)
//   -> streamed ZIP 200 (supervisor; errors 403, validation error [401 via
//   guard]).
//
// REQ-072 / REQ-077 / NFR-015 / RFP §4.9.5 / AC-51 / WALK-006 / SEC-14.
//
// - Supervisor roleGate via the single shared guard (INV-038).
// - Boundary validation FIRST (mode/since — 400), then the individual audit
//   row BEFORE any response bytes (task-039/040 precedent: actionType
//   "export", kind export_warehouse, actor from the session, params in
//   `after`).
// - Body is a STREAMED hand-rolled ZIP (src/lib/pure/zip.ts): one CSV per
//   star-schema table + schema.json, each table by keyset cursor — never
//   JSON, never a full-set memory load. Content-Disposition: attachment (§B).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { auditExport } from "@/lib/services/exports/audited-export";
import { iterableToReadableStream } from "@/lib/pure/zip";
import {
  generateWarehouseZip,
  parseWarehouseParams,
} from "@/lib/services/exports/warehouse";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;

  try {
    const params = parseWarehouseParams(request);

    // Individual audit row BEFORE any response bytes (REQ-072, SEC-8).
    await auditExport({
      user,
      kind: "export_warehouse",
      applicationId: null,
      summary:
        params.mode === "incremental"
          ? `Data-warehouse extract exported (incremental since ${params.since!.toISOString()})`
          : "Data-warehouse extract exported (full)",
      params: { mode: params.mode, since: params.since ? params.since.toISOString() : null },
      meta: requestMeta(request),
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(iterableToReadableStream(generateWarehouseZip(params)), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="warehouse-${params.mode}-${stamp}.zip"`,
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
