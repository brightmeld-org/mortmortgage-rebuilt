// POST /api/admin/staff/:id/reset-mfa — contracts §B: (no body) -> StaffAccountRow
// 200 (supervisor; errors: 403, 404, 409). REQ-013/REQ-063, INV-003.
//
// Dynamic segment named [id] — the established convention for /api/admin/staff/*
// (task-033 siblings deactivate/reactivate share it).
//
// INV-003 (other-users-only): self-reset is rejected 403 — a user's own MFA
// change must go through the password-plus-current-code re-enrollment path,
// because this admin path skips possession-factor proof. Success sets the
// target's MFA to the "reset" state (forcing re-enrollment at next sign-in),
// revokes every target session (SEC-20 — a stripped factor must not leave live
// sessions), audits with before/after, and notifies the target (real
// Notification + linked OutboundMessage rows, §D dispatch discipline).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { conflict, forbidden, notFound } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { resetMfaForStaff } from "@/lib/services/mfa";
import { loadStaffAccountRow } from "@/lib/services/staff";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;
  const { id } = await params;

  const result = await resetMfaForStaff(
    { userId: user.userId, sessionId: user.sessionId, role: user.role, email: user.email, isDemo: user.isDemo },
    id,
    requestMeta(request),
  );

  if (!result.ok) {
    switch (result.kind) {
      case "not-found":
        return notFound(requestId, "Staff account not found");
      case "self":
        // INV-003: never on self — use re-enrollment (password + current code).
        return forbidden(
          requestId,
          "You cannot reset your own MFA. Use the re-enrollment flow (password plus current code) instead.",
        );
      case "no-active-mfa":
        return conflict("This staff account has no active MFA enrollment to reset.", {
          requestId,
        });
    }
  }

  const row = await loadStaffAccountRow(id);
  if (!row) return notFound(requestId, "Staff account not found"); // vanished mid-request
  return Response.json(row);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
