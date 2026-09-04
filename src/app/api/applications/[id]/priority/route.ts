// PATCH /api/applications/:id/priority — contracts §B: PriorityRequest ->
//   Application 200 (supervisor only; validation error/403/404). Supervisor
//   priority override (task-021, REQ-057, VR-116/VR-117).
//
// Guard runs FIRST (roleGate ["supervisor"] — borrowers/caseworkers 403 before
// any body parsing), then the strict schema (VR-116 enum, VR-117 reason ≤ 500).
// The service (src/lib/services/priority.ts) verifies existence (404), applies
// priority + priorityOverride=true, audits before/after with the reason, and
// notifies the assigned caseworker — one transaction. Actor identity comes from
// the session only.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { priorityRequestSchema } from "@/lib/schemas/priority";
import { setPriorityOverride } from "@/lib/services/priority";

async function PATCH_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, priorityRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const application = await setPriorityOverride(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(application, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const PATCH = logged(PATCH_impl);
