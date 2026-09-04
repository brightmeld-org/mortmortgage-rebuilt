// DELETE /api/admin/demo-data — contracts §B: (no body) -> (empty) 204
// (supervisor; errors 403, 404, 409). REQ-066 / NFR-016 / WALK-004 / INV-009.
//
// DEMO-MODE GATE: absent (404) when DEMO_MODE !== "true", same pattern as
// POST /api/auth/demo-login. 409 while a seed/removal run is in flight
// (ASYNC-006 global-singleton advisory lock). Deletes ONLY isSeed-flagged
// records INCLUDING their seed-flagged audit entries (the sole audit delete
// path in the system) and nothing else; sets SeedRun.removedAt; restores the
// HMDA identifiers to blank iff they still hold the seeded values. Audited
// with the triggering Supervisor from the session as actor.

import { logged } from "@/lib/log";
import { notFound } from "next/navigation";
import { guard } from "@/lib/guard";
import { requestMeta } from "@/lib/http/client-ip";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { demoModeEnabled } from "@/lib/services/demo-login";
import { removeDemoData } from "@/lib/services/demo-seed";

async function DELETE_impl(request: Request): Promise<Response> {
  // Gate FIRST: with demo mode off this handler behaves as if it did not exist.
  if (!demoModeEnabled()) notFound();

  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;
  const meta = requestMeta(request);

  try {
    await removeDemoData({
      userId: user.userId,
      role: user.role,
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const DELETE = logged(DELETE_impl);
