// POST /api/admin/staff/:id/reactivate — contracts §B: (no body) -> StaffAccountRow
// 200 (supervisor; errors: 403, 404, 409). REQ-063.
//
// Dynamic segment named [id] — the established convention for /api/admin/staff/*.
//
// Flips an inactive staff account back to active (sign-in re-enabled). No
// assignment is recreated and MFA posture is untouched. Already-active -> 409.
// Audited in-transaction with the session actor.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { conflict, notFound } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { loadStaffAccountRow, reactivateStaff } from "@/lib/services/staff";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;
  const { id } = await params;

  const result = await reactivateStaff(
    { userId: user.userId, role: user.role },
    id,
    requestMeta(request),
  );

  if (!result.ok) {
    switch (result.kind) {
      case "not-found":
        return notFound(requestId, "Staff account not found");
      case "already-active":
        return conflict("This staff account is already active.", { requestId });
    }
  }

  const row = await loadStaffAccountRow(id);
  if (!row) return notFound(requestId, "Staff account not found"); // vanished mid-request
  return Response.json(row);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
