// POST /api/notifications/read-all — contracts §B: Ack 200 (roleGate
// ["authenticated-any"]; 401). REQ-070, task-036. Marks ONLY the session
// user's unread rows (record-level scoping).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { markAllNotificationsRead } from "@/lib/services/notifications";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;

  try {
    const ack = await markAllNotificationsRead(guarded.ctx.user);
    return Response.json(ack, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
