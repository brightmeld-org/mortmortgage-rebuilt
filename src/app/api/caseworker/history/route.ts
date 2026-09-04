// GET /api/caseworker/history — contracts §B: CompletionHistoryPage 200
// (caseworker ONLY; 401, 403; offset-limit max 100; ?page&pageSize; 12-month
// window FIXED server-side). REQ-048. Task-028.
//
// Scoped to the SESSION caseworker's own completions (record-level scoping).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { caseworkerHistory } from "@/lib/services/queue";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker"] });
  if (!guarded.ok) return guarded.response;

  try {
    const pagination = await getPagination(request, 100);
    const page = await caseworkerHistory(guarded.ctx.user, pagination);
    return Response.json(page);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
