// Session resolution + role enforcement for the BUILT-IN credential provider
// (REQ-002..005, REQ-016, NFR-004, SEC-19/SEC-20). This is the profile's
// authenticationHelper/authorizationHelper — every API route reaches sessions ONLY
// through this module (via src/lib/guard.ts).
//
// Session transport: HttpOnly cookie (SESSION_COOKIE_NAME) whose value is the raw
// random session token. The Session row stores only tokenHash = SHA-256(token) —
// issuance (cookie set + row creation + timeout values from SystemConfig) is
// task-006's job; this module resolves and ENFORCES what is stored on the row:
//   - revokedAt      → revoked sessions never authenticate (SEC-20)
//   - expiresAt      → ABSOLUTE expiry timestamp written at creation
//   - lastSeenAt     → IDLE expiry: lastSeenAt + idle-timeout window must cover now.
//     The idle window duration is not a column on the row (schema task-001); it is
//     read from SystemConfig (session.idleTimeoutMinutes, fallback 30 — §4.6.11)
//     at enforcement time. lastSeenAt slides forward on each authenticated request
//     (touch throttled to once per 30s to avoid a write per request).
//   - user.status    → inactive users never authenticate, even with a live row.
//   - user.emailVerifiedAt → an UNVERIFIED account never authenticates (§4.1.2 /
//     REQ-011): it is limited to the verification-pending surface, which is served
//     by guardVerificationPending (src/lib/guard.ts), not by this accessor.

import { createHash } from "node:crypto";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CONFIG_DEFAULTS, CONFIG_KEYS, getConfigNumber } from "@/lib/http/config";
import { forbidden, requestIdFrom, unauthorized } from "@/lib/http/errors";

/** Cookie carrying the raw session token. Task-006 sets it (HttpOnly, Secure, SameSite=Lax). */
export const SESSION_COOKIE_NAME = "mm_session";

/** Resolved, expiry-enforced session identity. All values come from live DB rows. */
export interface SessionUser {
  userId: string;
  sessionId: string;
  /** Verbatim contracts.json UserRole enum value: BORROWER | CASEWORKER | SUPERVISOR. */
  role: UserRole;
  email: string;
  firstName: string;
  lastName: string;
  isDemo: boolean;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  /** ISO 8601 UTC — feeds SessionInfo.idleExpiresAt (2-minute warning UI, task-006/044). */
  idleExpiresAt: string;
  /** ISO 8601 UTC — feeds SessionInfo.absoluteExpiresAt. */
  absoluteExpiresAt: string;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Resolve the request's session: cookie → Session row (joined User) → expiry/revocation
 * enforcement. Returns null for: no cookie, unknown token, revoked, pre-MFA,
 * UNVERIFIED EMAIL, absolute-expired, idle-expired, or inactive user. Never throws
 * for an invalid session.
 */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readSessionCookie(request);
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return null;

  const now = new Date();

  // Revocation (sign-out, password change/reset, deactivation, MFA reset — SEC-20).
  if (session.revokedAt !== null) return null;

  // Pre-MFA sessions never authenticate (§4.1.4): the password factor is verified but
  // the MFA factor is not. Only POST /api/auth/mfa/verify (task-007) may clear
  // mfaPendingAt; until then the session grants no API or page access here.
  if (session.mfaPendingAt !== null) return null;

  // Email verification (§4.1.2 / REQ-011; contracts.md FLOW-002 delivery state): an
  // account whose address is not verified is limited to the verification-pending
  // surface. This is a REQUEST-PATH gate, not merely a sign-in-time one — NO session,
  // however it was obtained, authenticates while emailVerifiedAt is null. Because it
  // lives here it covers all three protected surfaces at once: every API route (they
  // all resolve through src/lib/guard.ts `guard` → sessionLookup → here), every (app)
  // page AND the (app) layout (src/components/borrower/server-session.ts
  // resolveAppSession → here). Only guardVerificationPending / guardMfaFlow, which
  // resolve pending sessions deliberately, admit such an account — to
  // GET /api/auth/session, POST /api/auth/resend-verification and sign-out, nothing else.
  if (session.user.emailVerifiedAt === null) return null;

  // Absolute expiry — timestamp written on the row at creation (task-006, from SystemConfig).
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  // Idle expiry — lastSeenAt + configured idle window (see module header).
  const idleMinutes = await getConfigNumber(
    CONFIG_KEYS.sessionIdleTimeoutMinutes,
    CONFIG_DEFAULTS[CONFIG_KEYS.sessionIdleTimeoutMinutes],
  );
  const idleExpiresAtMs = session.lastSeenAt.getTime() + idleMinutes * 60_000;
  if (idleExpiresAtMs <= now.getTime()) return null;

  // Deactivated users never authenticate, even if a session row survived (belt for SEC-20).
  if (session.user.status !== "active") return null;

  // Slide the idle window (throttled: at most one write per 30s per session).
  let lastSeenAt = session.lastSeenAt;
  if (now.getTime() - session.lastSeenAt.getTime() > 30_000) {
    lastSeenAt = now;
    await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: now },
    });
  }

  const idleExpiresAt = new Date(lastSeenAt.getTime() + idleMinutes * 60_000);
  // idleExpiresAt never exceeds the absolute bound.
  const effectiveIdleExpiry =
    idleExpiresAt.getTime() < session.expiresAt.getTime() ? idleExpiresAt : session.expiresAt;

  return {
    userId: session.user.id,
    sessionId: session.id,
    role: session.user.role,
    email: session.user.email,
    firstName: session.user.firstName,
    lastName: session.user.lastName,
    isDemo: session.user.isDemo,
    emailVerified: session.user.emailVerifiedAt !== null,
    mfaEnrolled: await hasActiveMfaEnrollment(session.user.id),
    idleExpiresAt: effectiveIdleExpiry.toISOString(),
    absoluteExpiresAt: session.expiresAt.toISOString(),
  };
}

async function hasActiveMfaEnrollment(userId: string): Promise<boolean> {
  const enrollment = await prisma.mfaEnrollment.findFirst({
    where: { userId, status: "enrolled" },
    select: { id: true },
  });
  return enrollment !== null;
}

// ---------------------------------------------------------------------------
// Pre-MFA-tolerant accessor (task-007 MFA endpoints ONLY)
// ---------------------------------------------------------------------------

/**
 * §4.1.4 enrollment/challenge window: a pre-MFA session (Session.mfaPendingAt set)
 * is usable ONLY within this many minutes of mfaPendingAt. No SystemConfig key
 * exists for it in the §4.6.11 registry (checked task-007), so it is a constant.
 */
export const MFA_PENDING_WINDOW_MINUTES = 10;

/** getMfaFlowSession result: the resolved identity + whether it is a pre-MFA session. */
export interface MfaFlowSession {
  user: SessionUser;
  /** True when Session.mfaPendingAt is set (password factor only — §4.1.4). */
  preMfa: boolean;
}

/**
 * DEDICATED accessor for the task-007 MFA endpoints (enroll, enroll/verify,
 * verify) and sign-out — the ONLY surfaces a pre-MFA session may reach. It does
 * NOT weaken `getSessionUser` (which continues to reject pre-MFA sessions for
 * every other route): full sessions are delegated to `getSessionUser` unchanged;
 * pre-MFA sessions are resolved here with the checks that apply to them:
 *   - revokedAt / user.status / absolute expiresAt exactly as getSessionUser;
 *   - the 10-minute MFA_PENDING_WINDOW from mfaPendingAt REPLACES idle expiry
 *     (the window is far shorter than the idle timeout);
 *   - expired window → null (401: the user signs in again).
 * Never imported by any route outside the surfaces named above.
 */
export async function getMfaFlowSession(request: Request): Promise<MfaFlowSession | null> {
  const token = readSessionCookie(request);
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.mfaPendingAt === null) {
    // Full session — the general accessor's enforcement applies verbatim.
    const user = await getSessionUser(request);
    return user ? { user, preMfa: false } : null;
  }

  const now = new Date();
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= now.getTime()) return null;
  if (session.user.status !== "active") return null;

  const windowExpiresAt = new Date(
    session.mfaPendingAt.getTime() + MFA_PENDING_WINDOW_MINUTES * 60_000,
  );
  if (windowExpiresAt.getTime() <= now.getTime()) return null;

  const effectiveExpiry =
    windowExpiresAt.getTime() < session.expiresAt.getTime() ? windowExpiresAt : session.expiresAt;

  return {
    preMfa: true,
    user: {
      userId: session.user.id,
      sessionId: session.id,
      role: session.user.role,
      email: session.user.email,
      firstName: session.user.firstName,
      lastName: session.user.lastName,
      isDemo: session.user.isDemo,
      emailVerified: session.user.emailVerifiedAt !== null,
      mfaEnrolled: await hasActiveMfaEnrollment(session.user.id),
      idleExpiresAt: effectiveExpiry.toISOString(),
      absoluteExpiresAt: session.expiresAt.toISOString(),
    },
  };
}

/** Result union used by requireSession/requireRole: either the identity or the error Response. */
export type AuthResult =
  | { ok: true; user: SessionUser }
  | { ok: false; response: Response };

/** Resolve the session or produce the 401 ErrorResponse. */
export async function requireSession(request: Request): Promise<AuthResult> {
  const user = await getSessionUser(request);
  if (!user) return { ok: false, response: unauthorized(requestIdFrom(request)) };
  return { ok: true, user };
}

/**
 * Resolve the session AND require one of the given roles (verbatim UserRole values).
 * No session → 401; wrong role → 403. Runs before any body parsing (SEC-19).
 */
export async function requireRole(request: Request, ...roles: UserRole[]): Promise<AuthResult> {
  const result = await requireSession(request);
  if (!result.ok) return result;
  if (!roles.includes(result.user.role)) {
    return { ok: false, response: forbidden(requestIdFrom(request)) };
  }
  return result;
}
