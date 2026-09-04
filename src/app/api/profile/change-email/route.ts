// POST /api/profile/change-email — contracts §B: ChangeEmailRequest -> Ack 200
// (authenticated-any; errors: validation error, 401). REQ-041, VR-027/VR-028.
//
// §4.2.12: requires the current password; the OLD email stays active
// (UserProfile.pendingEmail carries the new one) until the verification link sent
// to the NEW address is consumed. Address availability is never disclosed here.
//
// DELETE /api/profile/change-email — contracts §B: - -> UserProfile 200
// (authenticated-any; errors: 401). REQ-041, CH-017. Abandons the pending change:
// same path, different method. Idempotent (200 no-op when nothing is pending) and
// state-changing, so it carries the same CSRF requirement as the POST.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, unauthorized } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { changeEmailRequestSchema } from "@/lib/schemas/auth";
import { cancelEmailChange, changeEmail } from "@/lib/services/profile";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  const parsed = await parseBody(request, changeEmailRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await changeEmail(
    { userId: user.userId, role: user.role },
    parsed.data,
    requestMeta(request),
  );
  if (!result.ok) {
    return unauthorized(requestIdFrom(request), "Current password is incorrect");
  }

  return Response.json({
    message:
      "Verification sent to the new address. Your current email remains active until the new one is verified.",
  });
}

async function DELETE_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  // No request body is contracted — the session user's own row is the only target.
  const profile = await cancelEmailChange(
    { userId: user.userId, role: user.role },
    requestMeta(request),
  );
  return Response.json(profile);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
export const DELETE = logged(DELETE_impl);
