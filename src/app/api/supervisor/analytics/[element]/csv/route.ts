// GET /api/supervisor/analytics/:element/csv — contracts §B: streamed text/csv
// of that element's aggregated data (responseBody "(empty)" — file-stream
// endpoints return streams, never JSON; SEC-14 no full-set memory loads).
// Supervisor only; errors 403, 404 (unknown element), validation error (same
// ?from&to rules as the dashboard, span ≤ 1096d). REQ-062.
//
// :element ∈ the contracts §B 12-value whitelist (summary|volume|status|
// loan-type|property-type|workload|ltv-risk|dti-risk|performance-trend|
// compliance|pending-approvals|activity) — unknown → 404. Cells are csv-safe
// (formula-leading characters escaped). Served with
// Content-Disposition: attachment (SEC-12 download convention).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, notFound, problemResponse, requestIdFrom } from "@/lib/http/errors";
import {
  analyticsElementTable,
  csvStream,
  isAnalyticsCsvElement,
  parseAnalyticsRange,
} from "@/lib/services/analytics";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ element: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId;

  const { element } = await params;
  if (!isAnalyticsCsvElement(element)) {
    return notFound(requestId, "Unknown analytics element");
  }

  try {
    const range = parseAnalyticsRange(request);
    const table = await analyticsElementTable(element, guarded.ctx.user, range);
    const fromTag = range.from.toISOString().slice(0, 10);
    const toTag = range.to.toISOString().slice(0, 10);
    return new Response(csvStream(table), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="analytics-${element}-${fromTag}-to-${toTag}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
