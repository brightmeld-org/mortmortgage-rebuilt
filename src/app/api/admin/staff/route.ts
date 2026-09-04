// /api/admin/staff — contracts §B (task-033):
//   GET  (no body) -> StaffListResponse 200 (supervisor; errors 401, 403; pagination "none (max 50)")
//   POST InviteStaffRequest -> StaffAccountRow 201 (supervisor; errors: validation error, 403)
//
// REQ-063 / REQ-011 / AC-41. The invitation is a REAL OutboundMessage row with
// the hashed-token set-password link (NFR-011/SEC-10); the invited account's
// first sign-in forces MFA enrollment (no MfaEnrollment rows). Duplicate email
// (INV-013) surfaces as the contract's validation error — this is a
// supervisor-facing endpoint, not the uniform-response public register.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { ERROR_CODES, errorResponse, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { inviteStaffRequestSchema } from "@/lib/schemas/staff";
import { inviteStaff, listStaffAccountRows, loadStaffAccountRow } from "@/lib/services/staff";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  return Response.json(await listStaffAccountRows());
}

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;

  const parsed = await parseBody(request, inviteStaffRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await inviteStaff(
    { userId: user.userId, role: user.role },
    parsed.data,
    requestMeta(request),
  );
  if (!result.ok) {
    // result.kind === "duplicate-email" (INV-013)
    return validationError(
      ["email: an account with this email address already exists"],
      requestId,
    );
  }

  const row = await loadStaffAccountRow(result.userId);
  if (!row) {
    // Vanished mid-request — unreachable in practice.
    return errorResponse(500, ERROR_CODES.internal, "Staff account could not be loaded", { requestId });
  }
  return Response.json(row, { status: 201 });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
export const POST = logged(POST_impl);
