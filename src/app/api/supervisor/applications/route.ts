// GET /api/supervisor/applications — contracts §B: SupervisorApplicationPage
// 200 (supervisor only; 401, 403; offset-limit max 100; date span ≤ 1096 days
// validated BEFORE querying → 400 validation error). REQ-055, NFR-024, NFR-015.
//
// Auto-applying filters ?states&caseworkerId&priority&slaStatus&loanType&
// submittedFrom&submittedTo&pendingApprovalLevel&needsMyLevel2&search&sort&dir&
// page&pageSize — parsed/validated in the task-031 service. needs-my-Level-2 is
// viewer-relative (INV-001 via the shared approval.ts eligibility rule).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import {
  listSupervisorApplications,
  parseSupervisorListParams,
} from "@/lib/services/supervisor-list";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  try {
    // Parameter validation (incl. the 1096-day span rule) runs BEFORE any
    // data query — parseSupervisorListParams throws the contract's 400.
    const params = parseSupervisorListParams(request);
    const pagination = await getPagination(request, 100);
    const page = await listSupervisorApplications(guarded.ctx.user, params, pagination);
    return Response.json(page);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
