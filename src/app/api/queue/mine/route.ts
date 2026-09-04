// GET /api/queue/mine — contracts §B: QueuePage 200 (caseworker, supervisor;
// 401, 403; offset-limit max 100; ?sort&dir&search&page&pageSize). REQ-047.
//
// RECORD-LEVEL SCOPING: WHERE-scoped to the SESSION user's ACTIVE assignments
// (never a client-supplied caseworker id). Task-028.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { listMyQueue, parseQueueListParams } from "@/lib/services/queue";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  try {
    const params = parseQueueListParams(request);
    const pagination = await getPagination(request, 100);
    const page = await listMyQueue(guarded.ctx.user, params, pagination);
    return Response.json(page);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
