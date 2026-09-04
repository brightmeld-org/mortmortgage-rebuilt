// POST /api/auth/resend-verification — contracts §B: (no body) -> Ack 200
// (authenticated-any; errors: 401, 429). REQ-011.
//
// The verification-pending page's "resend" action. Idempotent for already-verified
// accounts (same Ack, nothing sent). Session-bound CSRF applies (authenticated
// state-changing request).
//
// Guarded by guardVerificationPending (§4.1.2): the caller is by definition an
// account whose email is NOT verified, whose sign-in session is a pending one that
// `guard` refuses. That guard admits exactly the verification-pending session and a
// full session — nothing else — and still enforces session-bound CSRF.

import { logged } from "@/lib/log";
import { guardVerificationPending } from "@/lib/guard";
import { requestMeta } from "@/lib/http/client-ip";
import { resendVerification } from "@/lib/services/auth-account";
import { enforceRateLimit } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guardVerificationPending(request);
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  // §4.1.9 persisted rate limit — keyed session account + client IP (task-008).
  const limited = await enforceRateLimit(request, {
    scope: "resend-verification",
    policy: "auth",
    account: user.userId,
  });
  if (limited) return limited;

  await resendVerification({ userId: user.userId, role: user.role }, requestMeta(request));
  return Response.json({
    message: "If your email address is not yet verified, a new verification link has been sent.",
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
