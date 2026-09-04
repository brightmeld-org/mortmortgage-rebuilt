// GET /api/admin/outbound-messages — contracts §B: OutboundMessagesPage 200
// (roleGate ["supervisor"]; 401, 403; offset-limit max 100). REQ-071,
// INT-009/INT-020 — the §6.3.8 simulated email/SMS log surface. task-036.
//
// Lazily kicks the WALK-002 due-scan so pending automatic retries progress and
// their outcome rows appear on this page without the durable worker (task-045).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { listOutboundMessages, reconcileDueNotificationDeliveries } from "@/lib/services/notifications";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  try {
    await reconcileDueNotificationDeliveries();
    const pagination = await getPagination(request, 100);
    const page = await listOutboundMessages(pagination);
    return Response.json(page);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
