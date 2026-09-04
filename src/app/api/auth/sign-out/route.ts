// POST /api/auth/sign-out — contracts §B: (no body) -> 204 (authenticated-any;
// errors: 401). REQ-016/NFR-021: revokes the SERVER-SIDE session row (SEC-20) and
// clears the cookie. Session-bound CSRF applies to FULL sessions.
//
// task-007: uses the MFA-flow guard — sign-out is one of the two surfaces a
// PRE-MFA session may reach (§4.1.4: the enrollment window covers only the MFA
// endpoints plus sign-out), so an abandoned MFA challenge can revoke its session
// row properly instead of leaving it live until expiry. Pre-MFA sessions are
// CSRF-exempt by design (no token obtainable — see guardMfaFlow).
//
// allowUnverifiedEmail: the §4.1.2 verification-pending session is also a pending
// session, and abandoning THAT flow must work too — sign-out is the one MFA-flow
// surface an unverified account may reach (it only revokes its own session row).

import { logged } from "@/lib/log";
import { guardMfaFlow } from "@/lib/guard";
import { requestMeta } from "@/lib/http/client-ip";
import { getIdentityProvider } from "@/lib/services/idp";
import { clearSessionCookieHeader } from "@/lib/services/session";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guardMfaFlow(request, { allowUnverifiedEmail: true });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  // Provider seam (task-008): built-in signOut = the task-006 body verbatim
  // (revoke + in-transaction session-revocation audit, session-attributed).
  await getIdentityProvider().signOut(user, requestMeta(request));

  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSessionCookieHeader() },
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
