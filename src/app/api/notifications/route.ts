// GET /api/notifications — contracts §B: NotificationPage 200 (roleGate
// ["authenticated-any"]; 401; offset-limit max 100). REQ-070, task-036.
//
// Record-level scoping: STRICTLY the session user's own rows (the service
// filters on recipientUserId — role gates alone are never relied on).
// Lazily kicks the WALK-002 due-scan first (cheap when nothing is due) so
// automatic retries make progress without the durable worker (task-045).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { listNotifications, reconcileDueNotificationDeliveries } from "@/lib/services/notifications";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;

  try {
    await reconcileDueNotificationDeliveries();
    const pagination = await getPagination(request, 100);
    const page = await listNotifications(guarded.ctx.user, pagination);
    return Response.json(page);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
