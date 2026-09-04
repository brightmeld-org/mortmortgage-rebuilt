// POST /api/auth/sign-in — contracts §B: SignInRequest -> SignInResponse 200
// (public; errors: 401, 429, validation error). REQ-010/REQ-012/REQ-014.
//
// UNIFORM 401 (§4.1.3): wrong password, locked account, inactive account, and
// unknown email all return the BYTE-IDENTICAL body below — same code, same
// message, and deliberately NO requestId echo (a per-request id would break
// byte-identity). Timing is equalized in the service (full-cost argon2 verify on
// every path). CSRF exempt by design (public unauthenticated auth endpoint).
//
// Success issues the server-side session (HttpOnly/Secure/SameSite=Lax mm_session
// cookie). On ALL THREE non-signed-in statuses — mfa-required,
// mfa-enrollment-required, and verification-pending — it is a PENDING session
// (Session.mfaPendingAt set), which grants nothing: getSessionUser refuses it, so
// every protected page and API 401s until /api/auth/mfa/verify clears the flag
// AND the account's email is verified (§4.1.2/§4.1.4).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { ERROR_CODES, errorResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { signInRequestSchema } from "@/lib/schemas/auth";
import { SIGN_IN_FAILURE_MESSAGE } from "@/lib/services/auth-account";
import { getIdentityProvider } from "@/lib/services/idp";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { sessionCookieHeader } from "@/lib/services/session";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, signInRequestSchema);
  if (!parsed.ok) return parsed.response;

  // Persisted rate limit (task-008, §4.1.9): keyed by SUBMITTED account + client
  // IP — identical derivation whether or not the account exists (no existence leak).
  const limited = await enforceRateLimit(request, {
    scope: "sign-in",
    policy: "auth",
    account: parsed.data.email,
  });
  if (limited) return limited;

  const outcome = await getIdentityProvider().signIn(parsed.data, requestMeta(request));

  if (!outcome.ok) {
    // Byte-identical uniform failure — never varies by cause, never echoes requestId.
    return errorResponse(401, ERROR_CODES.unauthorized, SIGN_IN_FAILURE_MESSAGE);
  }

  // contracts §A SignInResponse — status literals verbatim from enums.SignInStatus.
  return Response.json(
    { status: outcome.status, redirectTo: outcome.redirectTo },
    {
      headers: {
        "set-cookie": sessionCookieHeader(outcome.issued.token, outcome.issued.maxAgeSeconds),
      },
    },
  );
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
