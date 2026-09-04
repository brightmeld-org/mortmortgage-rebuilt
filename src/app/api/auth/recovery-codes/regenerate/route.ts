// POST /api/auth/recovery-codes/regenerate — contracts §B: MfaReenrollRequest ->
// MfaEnrollVerifyResponse 200 (authenticated-any; errors: 401, validation error).
// REQ-013/REQ-041, VR-018..VR-020, INV-010.
//
// FULL session + CSRF (standard guard). Same credential requirements as
// re-enrollment: currentPassword AND exactly one of current TOTP code | unused
// recovery code. Success replaces the entire recovery-code set on the ACTIVE
// enrollment — every previous code is invalidated — and the fresh codes are
// returned exactly once (hashes only at rest).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { ERROR_CODES, errorResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { mfaReenrollRequestSchema } from "@/lib/schemas/mfa";
import { MFA_REAUTH_FAILURE_MESSAGE, regenerateRecoveryCodes } from "@/lib/services/mfa";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  const parsed = await parseBody(request, mfaReenrollRequestSchema); // VR-018..VR-020
  if (!parsed.ok) return parsed.response;

  const result = await regenerateRecoveryCodes(
    { userId: user.userId, sessionId: user.sessionId, role: user.role, email: user.email, isDemo: user.isDemo },
    parsed.data,
    requestMeta(request),
  );

  if (!result.ok) {
    return errorResponse(401, ERROR_CODES.unauthorized, MFA_REAUTH_FAILURE_MESSAGE);
  }

  // contracts §A MfaEnrollVerifyResponse — sole disclosure of the new codes.
  return Response.json({ recoveryCodes: result.recoveryCodes });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
