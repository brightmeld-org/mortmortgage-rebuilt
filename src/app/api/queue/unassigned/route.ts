// GET /api/queue/unassigned — contracts §B: QueuePage 200 (caseworker,
// supervisor; 401, 403; offset-limit max 100; ?sort&dir&search&page&pageSize).
// REQ-047, REQ-003, NFR-023, NFR-015.
//
// RECORD-LEVEL SCOPING (SEC-22 / S-2): rows are the QueueRow summary
// projection ONLY — the service serializer emits no identity, contact, asset,
// or liability detail. Task-028.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { listUnassignedQueue, parseQueueListParams } from "@/lib/services/queue";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  try {
    const params = parseQueueListParams(request);
    const pagination = await getPagination(request, 100);
    const page = await listUnassignedQueue(params, pagination);
    return Response.json(page);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
