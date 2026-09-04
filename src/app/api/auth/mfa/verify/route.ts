// POST /api/auth/mfa/verify — contracts §B: MfaVerifyRequest -> SignInResponse
// 200 (public; errors: 401, 429, validation error). REQ-013/NFR-012,
// VR-016/VR-017, INV-010/INV-034.
//
// "Public" in the roleGate sense: the caller holds only the PRE-MFA session
// cookie (password verified, second factor outstanding) — resolved through the
// dedicated pre-MFA-tolerant accessor, never getSessionUser. CSRF exempt by
// design (public auth handshake — src/lib/csrf.ts module header). Only the
// ENROLLED secret authenticates; a pending secret never does (INV-034). A valid
// unused recovery code is consumed atomically (INV-010 — concurrent double use
// has exactly one winner) and the response prompts re-enrollment via redirectTo
// (SignInStatus has no dedicated value; /profile hosts re-enrollment per §C
// ProfilePage). Uniform 401 for every failure cause. 429 from the middleware
// rate limiter (task-008 replaces its store).

import { logged } from "@/lib/log";
import { parseBody } from "@/lib/http/validation";
import { ERROR_CODES, errorResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { ROLE_HOME } from "@/lib/role-home";
import { mfaVerifyRequestSchema } from "@/lib/schemas/mfa";
import { getIdentityProvider } from "@/lib/services/idp";
import { completeMfaChallenge, MFA_VERIFY_FAILURE_MESSAGE } from "@/lib/services/mfa";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { isUserPasswordExpired } from "@/lib/services/password-policy";

/** Recovery-code sign-in lands on the profile page, which hosts re-enrollment (§C). */
const REENROLL_PROMPT_REDIRECT = "/profile?mfaReenroll=1";
/**
 * REQ-014 §4.1.5: an expired password is prompted for change at sign-in. Like the
 * re-enrollment prompt, SignInStatus has no dedicated value, so the prompt is
 * surfaced via redirectTo to the profile page (which hosts change-password, §C).
 * Takes precedence over the re-enrollment prompt — the credential must be rotated
 * before anything else. (LENS-018.)
 */
const PASSWORD_EXPIRED_REDIRECT = "/profile?passwordExpired=1";

async function POST_impl(request: Request): Promise<Response> {
  // Auth (session resolution) before body parsing (SEC-19). A full session, a
  // missing cookie, or an expired 10-minute window all yield the uniform 401 —
  // only a live pre-MFA session has a challenge to complete. Resolution goes
  // through the provider seam (task-008).
  const flow = await getIdentityProvider().mfaHandoff(request);

  // §4.1.9 rate limit ("MFA code verification is rate-limited"), persisted,
  // keyed session account + client IP (sessionless probes bucket per-IP).
  const limited = await enforceRateLimit(request, {
    scope: "mfa-verify",
    policy: "auth",
    account: flow?.user.userId ?? null,
  });
  if (limited) return limited;

  if (!flow || !flow.preMfa) {
    return errorResponse(401, ERROR_CODES.unauthorized, MFA_VERIFY_FAILURE_MESSAGE);
  }
  const { user } = flow;

  const parsed = await parseBody(request, mfaVerifyRequestSchema); // VR-016/VR-017
  if (!parsed.ok) return parsed.response;

  const result = await completeMfaChallenge(
    { userId: user.userId, sessionId: user.sessionId, role: user.role, email: user.email, isDemo: user.isDemo },
    parsed.data,
    requestMeta(request),
  );

  if (!result.ok) {
    // Byte-identical uniform failure — wrong TOTP, replayed step, consumed or
    // unknown recovery code, pending-only enrollment. Never discloses which.
    return errorResponse(401, ERROR_CODES.unauthorized, MFA_VERIFY_FAILURE_MESSAGE);
  }

  // REQ-014 §4.1.5: prompt for a password change at sign-in when the password has
  // expired. Evaluated here because this is where the returning user is granted a
  // FULL session; the expiry prompt takes precedence over the re-enrollment prompt.
  const passwordExpired = await isUserPasswordExpired(user.userId);

  // contracts §A SignInResponse — status literal verbatim from enums.SignInStatus.
  return Response.json({
    status: "signed-in",
    redirectTo: passwordExpired
      ? PASSWORD_EXPIRED_REDIRECT
      : result.usedRecoveryCode
        ? REENROLL_PROMPT_REDIRECT
        : ROLE_HOME[user.role],
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
