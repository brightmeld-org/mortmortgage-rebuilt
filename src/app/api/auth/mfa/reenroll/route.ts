// POST /api/auth/mfa/reenroll — contracts §B: MfaReenrollRequest -> MfaEnrollInit
// 200 (authenticated-any; errors: 401, validation error). REQ-013/REQ-041,
// VR-018..VR-020, INV-003 (self-service path), INV-034.
//
// FULL session required: the standard guard's getSessionUser rejects pre-MFA
// sessions, and session-bound CSRF applies. Requires currentPassword AND exactly
// one of current TOTP code | unused recovery code (the recovery code is consumed
// — INV-010). Issues a NEW pending secret; the ACTIVE secret stays authoritative
// until the new one is verified via POST /api/auth/mfa/enroll/verify, which also
// rotates the recovery codes (INV-034 semantics).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { ERROR_CODES, errorResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { mfaReenrollRequestSchema } from "@/lib/schemas/mfa";
import { initReenroll, MFA_REAUTH_FAILURE_MESSAGE } from "@/lib/services/mfa";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  const parsed = await parseBody(request, mfaReenrollRequestSchema); // VR-018..VR-020
  if (!parsed.ok) return parsed.response;

  const result = await initReenroll(
    { userId: user.userId, sessionId: user.sessionId, role: user.role, email: user.email, isDemo: user.isDemo },
    parsed.data,
    requestMeta(request),
  );

  if (!result.ok) {
    // Uniform 401 — wrong password, wrong/replayed code, consumed recovery code,
    // or no active enrollment. Cause never disclosed.
    return errorResponse(401, ERROR_CODES.unauthorized, MFA_REAUTH_FAILURE_MESSAGE);
  }

  return Response.json(result.init);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
