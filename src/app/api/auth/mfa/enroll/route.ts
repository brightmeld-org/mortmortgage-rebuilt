// POST /api/auth/mfa/enroll — contracts §B: (no body) -> MfaEnrollInit 200
// (authenticated-any; errors: 401, 409). REQ-013.
//
// Reachable on the PRE-MFA session (the §4.1.4 10-minute enrollment window) via
// guardMfaFlow — the ONLY pre-MFA-tolerant guard. INV-034: while an ACTIVE
// ("enrolled") secret exists this call is rejected 409 and the active secret is
// untouched; a PENDING secret may be regenerated freely and never authenticates.

import { logged } from "@/lib/log";
import { guardMfaFlow } from "@/lib/guard";
import { conflict } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { startEnrollment } from "@/lib/services/mfa";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guardMfaFlow(request);
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;

  const result = await startEnrollment(
    { userId: user.userId, sessionId: user.sessionId, role: user.role, email: user.email, isDemo: user.isDemo },
    requestMeta(request),
  );

  if (!result.ok) {
    // INV-034: an enrollment call never overwrites an active enrollment.
    return conflict(
      "MFA is already enrolled for this account. Use the re-enrollment flow (password plus current code) to change it.",
      { requestId },
    );
  }

  // contracts §A MfaEnrollInit — exact field names; secret shown at issue time only.
  return Response.json(result.init);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
