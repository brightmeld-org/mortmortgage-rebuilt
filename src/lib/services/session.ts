// Server-side session lifecycle (§4.1.7, REQ-016, NFR-004, NFR-021, SEC-3/SEC-20).
//
// Issuance (this module) writes the revocable Session row and builds the cookie;
// resolution/enforcement lives in src/lib/auth.ts (idle + absolute expiry,
// revocation, pre-MFA rejection). The cookie value is the RAW random token; only
// its SHA-256 lands in the row (Session.tokenHash, unique-indexed).
//
// Cookie attributes (SEC-3): HttpOnly; Secure; SameSite=Lax; Path=/. Max-Age is
// the ABSOLUTE lifetime — idle expiry is enforced server-side from lastSeenAt, so
// a cookie that outlives its idle window simply resolves to no session (401 with
// the cookie cleared by the guard).

import { randomBytes } from "node:crypto";
import type { Session } from "@prisma/client";
import { hashSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { CONFIG_DEFAULTS, CONFIG_KEYS, getConfigNumber } from "@/lib/http/config";
import type { AuditTransactionClient } from "@/lib/services/audit";

export interface IssuedSession {
  /** Raw cookie value — exists only in the Set-Cookie header, never persisted or logged. */
  token: string;
  session: Session;
  /** Absolute lifetime in seconds (cookie Max-Age). */
  maxAgeSeconds: number;
}

/**
 * Create a session row for a user. `mfaPending: true` issues the §4.1.4 pre-MFA
 * session (password verified, MFA factor outstanding — never authenticates until
 * task-007's verify endpoint clears mfaPendingAt). Timeouts come from LIVE
 * SystemConfig (session.absoluteTimeoutHours; idle window is read at enforcement
 * time by src/lib/auth.ts).
 */
export async function createSession(
  tx: AuditTransactionClient,
  input: {
    userId: string;
    mfaPending: boolean;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<IssuedSession> {
  const absoluteHours = await getConfigNumber(
    CONFIG_KEYS.sessionAbsoluteTimeoutHours,
    CONFIG_DEFAULTS[CONFIG_KEYS.sessionAbsoluteTimeoutHours],
  );
  const maxAgeSeconds = Math.floor(absoluteHours * 3600);
  const token = randomBytes(32).toString("base64url");
  const now = new Date();

  const session = await tx.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + maxAgeSeconds * 1000),
      mfaPendingAt: input.mfaPending ? now : null,
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });

  return { token, session, maxAgeSeconds };
}

/** Revoke one session (sign-out). Returns true when a live session was revoked. */
export async function revokeSession(tx: AuditTransactionClient, sessionId: string): Promise<boolean> {
  const result = await tx.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/**
 * SEC-20: revoke every active session of a user except `exceptSessionId` (pass
 * null to revoke ALL — password reset, deactivation). Returns the revoked count.
 */
export async function revokeOtherSessions(
  tx: AuditTransactionClient,
  userId: string,
  exceptSessionId: string | null,
): Promise<number> {
  const result = await tx.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Cookie serialization
// ---------------------------------------------------------------------------

/** Set-Cookie header value delivering the session token (SEC-3 attributes). */
export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** Set-Cookie header value clearing the session cookie (sign-out, dead-session 401s). */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Whether the request presented a (possibly dead) session cookie at all. */
export function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get("cookie");
  if (!header) return false;
  return header
    .split(";")
    .some((part) => part.slice(0, part.indexOf("=")).trim() === SESSION_COOKIE_NAME);
}
