// POST /api/auth/reset-password — contracts §B: ResetPasswordRequest -> Ack 200
// (public; errors: validation error, 429). REQ-014/REQ-015/NFR-021.
//
// INV-010: race-safe single consumption (atomic conditional claim — two concurrent
// consumers, exactly one wins). Applies the full §4.1.5 policy (incl. history) and
// revokes EVERY active session on success (SEC-20). CSRF exempt by design.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { resetPasswordRequestSchema } from "@/lib/schemas/auth";
import { resetPassword } from "@/lib/services/auth-account";
import { enforceRateLimit, tokenRateLimitAccount } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, resetPasswordRequestSchema);
  if (!parsed.ok) return parsed.response;

  // §4.1.9 persisted rate limit (reset SUBMIT). Token-only body — per-token account
  // dimension (INV-042/CH-019): keys per-token so the request is never unkeyed and
  // fail-open (LENS-016), without a scope-global ceiling one caller could exhaust.
  const limited = await enforceRateLimit(request, {
    scope: "reset-password",
    policy: "auth",
    account: tokenRateLimitAccount(parsed.data.token),
  });
  if (limited) return limited;

  const result = await resetPassword(parsed.data, requestMeta(request));
  if (!result.ok) {
    const details =
      result.kind === "policy"
        ? result.details
        : ["token: invalid or expired reset token"]; // one message for unknown/expired/used
    return validationError(details, requestIdFrom(request));
  }

  return Response.json({
    message: "Your password has been reset. Sign in with your new password.",
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
