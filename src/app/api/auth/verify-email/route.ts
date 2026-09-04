// POST /api/auth/verify-email — contracts §B: VerifyEmailRequest -> Ack 200
// (public; errors: validation error, 429). REQ-011/NFR-011, INV-010 (race-safe
// single consumption). CSRF exempt by design (public unauthenticated auth endpoint).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { verifyEmailRequestSchema } from "@/lib/schemas/auth";
import { verifyEmail } from "@/lib/services/auth-account";
import { enforceRateLimit, tokenRateLimitAccount } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, verifyEmailRequestSchema);
  if (!parsed.ok) return parsed.response;

  // §4.1.9 persisted rate limit (§B row lists 429). Token-only body — per-token
  // account dimension (INV-042/CH-019): keys per-token so a null-account request
  // is never left unkeyed and fail-open (LENS-016), without a scope-global ceiling
  // that a single caller could exhaust for everyone.
  const limited = await enforceRateLimit(request, {
    scope: "verify-email",
    policy: "auth",
    account: tokenRateLimitAccount(parsed.data.token),
  });
  if (limited) return limited;

  const result = await verifyEmail(parsed.data.token, requestMeta(request));
  if (!result.ok) {
    // One message for unknown/expired/already-used — no cause disclosure (INV-010).
    return validationError(
      ["token: invalid or expired verification token"],
      requestIdFrom(request),
    );
  }
  return Response.json({ message: "Email address verified. You can now sign in." });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
