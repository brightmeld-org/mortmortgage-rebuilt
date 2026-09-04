// POST /api/auth/accept-invitation — contracts §B: AcceptInvitationRequest -> Ack
// 200 (public; errors: validation error, 429). REQ-063 / NFR-011 / INV-010.
//
// Sets the invited staff account's password from the hashed single-use
// invitation token. Composed exactly like the other public token-flow auth
// endpoints (reset-password): public guard, CSRF exempt by design, §4.1.9
// persisted rate limit (token-only body — per-IP bucket), ONE uniform failure
// for unknown/expired/already-used tokens (no cause disclosure).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { acceptInvitationRequestSchema } from "@/lib/schemas/auth";
import { acceptInvitation } from "@/lib/services/staff";
import { enforceRateLimit, tokenRateLimitAccount } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, acceptInvitationRequestSchema);
  if (!parsed.ok) return parsed.response;

  // §4.1.9 persisted rate limit ("auth" policy, like reset-password). Token-only
  // body — per-token account dimension (INV-042/CH-019) so the request is never
  // unkeyed and fail-open (LENS-016).
  const limited = await enforceRateLimit(request, {
    scope: "accept-invitation",
    policy: "auth",
    account: tokenRateLimitAccount(parsed.data.token),
  });
  if (limited) return limited;

  const result = await acceptInvitation(parsed.data, requestMeta(request));
  if (!result.ok) {
    const details =
      result.kind === "policy"
        ? result.details
        : ["token: invalid or expired invitation token"]; // one message for unknown/expired/used
    return validationError(details, requestIdFrom(request));
  }

  return Response.json({
    message: "Your password has been set. Sign in to continue — you will enroll multi-factor authentication on your first sign-in.",
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
