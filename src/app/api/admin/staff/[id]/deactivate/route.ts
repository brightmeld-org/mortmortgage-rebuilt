// POST /api/admin/staff/:id/deactivate — contracts §B: (no body) -> StaffAccountRow
// 200 (supervisor; errors: 403, 404, 409). REQ-063 / NFR-021 / XBR-015.
//
// Dynamic segment named [id] — the established convention for /api/admin/staff/*.
//
// Guards: INV-002 self-deactivation -> 403 (same shape as reset-mfa's INV-003
// self case); INV-005 last-active-Supervisor -> 409, decided transactionally
// under FOR UPDATE row locks (safe under concurrent attempts); already-inactive
// -> 409. Deactivating the last caseworker IS permitted (INV-006 — explicit
// no-invariant). Success revokes all sessions, closes active assignments via
// the assignment.ts close path (applications return to Unassigned; workflow
// state untouched), notifies all Supervisors, and audits in-transaction.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { conflict, forbidden, notFound } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { deactivateStaff, loadStaffAccountRow } from "@/lib/services/staff";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;
  const { id } = await params;

  const result = await deactivateStaff(
    { userId: user.userId, role: user.role },
    id,
    requestMeta(request),
  );

  if (!result.ok) {
    switch (result.kind) {
      case "not-found":
        return notFound(requestId, "Staff account not found");
      case "self":
        // INV-002: the deactivate-user operation must never be applied to the
        // actor's own account.
        return forbidden(requestId, "You cannot deactivate your own account.");
      case "already-inactive":
        return conflict("This staff account is already inactive.", { requestId });
      case "last-supervisor":
        // INV-005: the active-Supervisor count must never reach zero.
        return conflict(
          "Cannot deactivate the last active supervisor account — at least one active supervisor is required.",
          { requestId },
        );
    }
  }

  const row = await loadStaffAccountRow(id);
  if (!row) return notFound(requestId, "Staff account not found"); // vanished mid-request
  return Response.json(row);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
