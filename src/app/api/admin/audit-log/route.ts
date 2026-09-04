// GET /api/admin/audit-log — contracts §B (task-039):
//   (no body) -> AuditLogPage 200 (supervisor; errors 401, 403, validation
//   error; offset-limit max 100; viewer default 25/page; span ≤ 1096d).
//
// REQ-064 / NFR-015 / INV-009. Filters per §B ~line 2654 (auto-applying):
// ?actionType=&applicationSearch=&userSearch=&from=&to=&page (+ pageSize,
// server-clamped to ≤ 100 — AC-59/INV-036).
//
// INV-009 (BLOCKING): the audit log has ZERO HTTP write endpoints. This file
// exports GET ONLY — no POST/PUT/PATCH/DELETE handler may ever be added here
// for any role; Next.js answers non-GET methods with 405.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { listAuditLog, parseAuditLogParams } from "@/lib/services/audit-log";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { requestId } = guarded.ctx;

  try {
    // Validation (incl. the 1096-day span rule) runs BEFORE any data query.
    const { filters } = parseAuditLogParams(request);
    const pagination = await getPagination(request, 100);
    return Response.json(await listAuditLog(filters, pagination));
  } catch (error) {
    if (error instanceof HttpProblem) return problemResponse(error, requestId);
    throw error;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
