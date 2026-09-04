// GET /api/auth/session — contracts §B: SessionInfo | 401, roleGate authenticated-any
// (REQ-016, NFR-004).
//
// Pure session-read: belongs to the task-005 enforcement layer (it serializes the
// resolved session and mints the session-bound CSRF token the client uses on every
// state-changing request). All other /api/auth/* endpoints are task-006.
//
// Resolution goes through guardVerificationPending (§4.1.2), NOT the general guard:
// this endpoint is part of the verification-pending surface — SessionInfo.emailVerified
// exists precisely to describe an unverified account, and the resend action on
// /verify-email cannot run without the csrfToken minted here. A pre-MFA session is
// still 401 (no csrfToken is obtainable for an MFA challenge), and every OTHER
// protected route uses `guard`, which refuses both kinds of pending session.

import { logged } from "@/lib/log";
import { csrfTokenForSession } from "@/lib/csrf";
import { guardVerificationPending } from "@/lib/guard";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guardVerificationPending(request);
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  // contracts.md §A SessionInfo — exact field names.
  return Response.json({
    userId: user.userId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    isDemo: user.isDemo,
    emailVerified: user.emailVerified,
    mfaEnrolled: user.mfaEnrolled,
    idleExpiresAt: user.idleExpiresAt,
    absoluteExpiresAt: user.absoluteExpiresAt,
    csrfToken: csrfTokenForSession(user.sessionId),
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
