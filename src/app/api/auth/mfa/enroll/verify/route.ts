// POST /api/auth/mfa/enroll/verify — contracts §B: MfaEnrollVerifyRequest ->
// MfaEnrollVerifyResponse 200 (authenticated-any; errors: validation error, 401,
// 429). REQ-013, VR-015.
//
// Reachable on the PRE-MFA session (enrollment flow) AND on a full session
// (re-enrollment completion). A valid TOTP code activates the PENDING secret;
// the response carries the ≥10 single-use recovery codes EXACTLY ONCE — they are
// stored only as hashes and can never be retrieved again. A pre-MFA session is
// promoted to a full session in the same transaction. Uniform 401 for wrong
// code / no pending secret (cause never disclosed). 429 from the persisted
// §4.1.9 limiter (task-008), keyed session account + client IP.

import { logged } from "@/lib/log";
import { guardMfaFlow } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { ERROR_CODES, errorResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { mfaEnrollVerifyRequestSchema } from "@/lib/schemas/mfa";
import { activateEnrollment, MFA_VERIFY_FAILURE_MESSAGE } from "@/lib/services/mfa";
import { enforceRateLimit } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guardMfaFlow(request); // auth before body parsing (SEC-19)
  if (!guarded.ok) return guarded.response;
  const { user, preMfa } = guarded.ctx;

  const limited = await enforceRateLimit(request, {
    scope: "mfa-enroll-verify",
    policy: "auth",
    account: user.userId,
  });
  if (limited) return limited;

  const parsed = await parseBody(request, mfaEnrollVerifyRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await activateEnrollment(
    { userId: user.userId, sessionId: user.sessionId, role: user.role, email: user.email, isDemo: user.isDemo },
    { preMfa },
    parsed.data.code,
    requestMeta(request),
  );

  if (!result.ok) {
    // Byte-identical uniform failure (wrong code, no pending secret, raced away).
    return errorResponse(401, ERROR_CODES.unauthorized, MFA_VERIFY_FAILURE_MESSAGE);
  }

  // contracts §A MfaEnrollVerifyResponse — the ONE AND ONLY disclosure of the codes.
  return Response.json({ recoveryCodes: result.recoveryCodes });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
