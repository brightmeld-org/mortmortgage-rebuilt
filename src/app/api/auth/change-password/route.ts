// POST /api/auth/change-password — contracts §B: ChangePasswordRequest -> Ack 200
// (authenticated-any; errors: validation error, 401). REQ-014/REQ-015/NFR-021.
//
// §4.1.6: requires the current password (wrong current password -> 401); applies
// the full §4.1.5 policy; revokes every OTHER active session (SEC-20) — the
// session performing the change stays alive. Session-bound CSRF applies.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, unauthorized, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { changePasswordRequestSchema } from "@/lib/schemas/auth";
import { changePassword } from "@/lib/services/auth-account";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  const parsed = await parseBody(request, changePasswordRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await changePassword(
    { userId: user.userId, sessionId: user.sessionId, role: user.role },
    parsed.data,
    requestMeta(request),
  );

  if (!result.ok) {
    if (result.kind === "wrong-current-password") {
      return unauthorized(requestIdFrom(request), "Current password is incorrect");
    }
    return validationError(result.details, requestIdFrom(request));
  }

  return Response.json({
    message: "Your password has been changed. Other active sessions have been signed out.",
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
