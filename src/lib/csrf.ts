// Session-BOUND CSRF protection (SEC-3, NFR-004) — synchronizer/HMAC pattern.
//
// Pattern: the token is HMAC-SHA256(secret, sessionId) — deterministically derived
// from the server-side session identifier, so it is bound to exactly one session and
// cannot be minted or replayed by an attacker without the server secret. This is NOT
// a bare double-submit cookie (explicitly not acceptable per SEC-3): the browser
// never receives the token in a cookie; the ONLY client source is
// `SessionInfo.csrfToken` from `GET /api/auth/session`, and the client must send it
// back on every state-changing request (POST/PUT/PATCH/DELETE) in the
// `X-CSRF-Token` header. Verification recomputes the HMAC from the authenticated
// session row — missing, malformed, or wrong-session tokens → 403 ErrorResponse.
//
// Public unauthenticated endpoints (register, sign-in, forgot/reset-password,
// verify-email, MFA verify, demo login, public calculators) are EXEMPT BY DESIGN:
// the CSRF bind starts at session issuance — there is no session to bind a token to
// before authentication, and those endpoints carry no ambient credential a
// cross-site request could ride on. Enforcement is wired centrally in
// src/lib/guard.ts: any guarded request that resolves a session and uses a
// state-changing method is verified here.
//
// Secret: CSRF_SECRET (or SESSION_SECRET) from the environment. In production a
// missing secret is a hard startup defect (fail closed); in development a
// deterministic dev-only fallback keeps local runs working without extra setup.

import { createHmac, timingSafeEqual } from "node:crypto";

export const CSRF_HEADER_NAME = "x-csrf-token";

/** HTTP methods that mutate state and therefore require CSRF verification. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

function csrfSecret(): string {
  const secret = process.env.CSRF_SECRET ?? process.env.SESSION_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    // Fail closed: without a secret every state-changing request would be forgeable.
    throw new Error("CSRF_SECRET (or SESSION_SECRET) must be set in production");
  }
  return "mortmortgage-dev-only-csrf-secret";
}

/**
 * Derive the session-bound synchronizer token for a session row.
 * Serialized to the client only via SessionInfo.csrfToken (GET /api/auth/session).
 */
export function csrfTokenForSession(sessionId: string): string {
  return createHmac("sha256", csrfSecret()).update(sessionId).digest("hex");
}

/**
 * Verify the X-CSRF-Token header against the authenticated session.
 * Returns true only when the presented token is the HMAC bound to THIS session.
 * Constant-time comparison; length mismatch short-circuits (no timing signal of value).
 */
export function verifyCsrfToken(presented: string | null, sessionId: string): boolean {
  if (!presented) return false;
  const expected = csrfTokenForSession(sessionId);
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/**
 * Request-level check used by the shared guard: extracts the header and verifies
 * it against the resolved session id.
 */
export function verifyCsrfRequest(request: Request, sessionId: string): boolean {
  return verifyCsrfToken(request.headers.get(CSRF_HEADER_NAME), sessionId);
}
