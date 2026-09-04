// GET /api/supervisor/analytics — contracts §B: AnalyticsDashboardResponse
// 200 (supervisor only; 401, 403, validation error; ?from&to default last 12
// months, span ≤ 1096d → 400 BEFORE any data query). REQ-062, NFR-015, NFR-024.
//
// Every figure is a DB aggregation via the task-038 analytics service — SEC-14
// forbids loading the full application set into memory (query-log verified by
// verification/increment-9/task-038).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getAnalyticsDashboard, parseAnalyticsRange } from "@/lib/services/analytics";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  try {
    // Range validation (incl. the 1096-day span rule) runs BEFORE any query.
    const range = parseAnalyticsRange(request);
    const dashboard = await getAnalyticsDashboard(guarded.ctx.user, range);
    return Response.json(dashboard);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
