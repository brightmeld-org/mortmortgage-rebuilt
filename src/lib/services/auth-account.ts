// Credential auth core (task-006): registration, email verification, sign-in with
// lockout, forgot/reset/change password. §4.1.1–4.1.6, REQ-010/011/014/015,
// NFR-011/NFR-021, INV-010/INV-013, SEC-10/SEC-20.
//
// Route handlers delegate here; every audited mutation runs its DB writes and the
// audit insert on ONE transaction client (task-003 contract — audit failure rolls
// the mutation back). Raw tokens exist only in returned/persisted OutboundMessage
// bodies — NEVER in logs or audit summaries.
//
// Uniform responses (no account-existence disclosure):
//   - register / forgot-password: byte-identical Ack whether or not the account exists.
//   - sign-in failure: ONE 401 body ("invalid email or password") for wrong password,
//     locked account, inactive account, and unknown email — with a full-cost argon2
//     verify burned on every path so timing does not disclose existence either.

import type { User, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getConfigNumber } from "@/lib/http/config";
import { audit } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "@/lib/services/password-hash";
import { validatePasswordPolicy } from "@/lib/services/password-policy";
import { consumeToken, issueToken, peekToken, sha256Hex } from "@/lib/services/tokens";
import { appBaseUrl, recordOutboundEmail } from "@/lib/services/outbound";
import { createSession, revokeOtherSessions, type IssuedSession } from "@/lib/services/session";

/** Request-derived metadata recorded on sessions and audit entries. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

// Uniform Ack messages (§4.1.2 / §4.1.6 — identical strings on both branches).
export const REGISTER_ACK_MESSAGE =
  "Registration received. If the email address can be registered, a verification message has been sent to it.";
export const FORGOT_ACK_MESSAGE =
  "If an account exists for that address, a password reset link has been sent.";
/** §4.1.3 uniform sign-in failure message — byte-identical for every cause. */
export const SIGN_IN_FAILURE_MESSAGE = "invalid email or password";

const VERIFY_EMAIL_SUBJECT = "Verify your MortMortgage email address";
const RESET_SUBJECT = "Reset your MortMortgage password";

function findUserByEmail(email: string): Promise<User | null> {
  // INV-013 comparison semantics: lower(email) unique — lookups are case-insensitive.
  return prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
}

// ---------------------------------------------------------------------------
// Registration + email verification (§4.1.2, REQ-011)
// ---------------------------------------------------------------------------

export async function register(
  input: { firstName: string; lastName: string; email: string; password: string },
  meta: RequestMeta,
): Promise<void> {
  const email = input.email.trim();
  const passwordHash = await hashPassword(input.password);

  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          role: "BORROWER", // §4.1.2: self-registration creates Borrowers only
          firstName: input.firstName,
          lastName: input.lastName,
          passwordChangedAt: new Date(),
        },
      });
      await tx.passwordHistory.create({ data: { userId: user.id, passwordHash } });

      // §4.8.2 borrower trigger "registration verification" (task-036): in-app
      // row via THE notification service. External mode "none" — the token
      // email below IS the external message (raw token never re-composed
      // elsewhere); it is linked back via OutboundMessage.notificationId.
      const notification = await createNotification(tx, {
        recipientUserId: user.id,
        type: "registration-verification",
        title: "Verify your email address",
        body:
          `Welcome to MortMortgage! A verification link was sent to ${email}. ` +
          `Verify within 24 hours to activate your account.`,
        externalDelivery: "none",
      });

      const { raw } = await issueToken(tx, user.id, "verify-email");
      await recordOutboundEmail(tx, {
        recipient: email,
        subject: VERIFY_EMAIL_SUBJECT,
        body:
          `Welcome to MortMortgage, ${input.firstName}!\n\n` +
          `Verify your email address within 24 hours using this single-use link:\n` +
          `${appBaseUrl()}/verify-email?token=${raw}\n\n` +
          `If you did not create this account, you can ignore this message.`,
        notificationId: notification.id,
      });

      await audit(tx, {
        actor: null, // public endpoint — no authenticated session yet
        role: null,
        actionType: "account-registration",
        entityType: "User",
        entityId: user.id,
        summary: `Borrower account registered (verification pending)`,
        ip: meta.ip,
        requestId: meta.requestId,
      });
    });
  } catch (error) {
    // INV-013 unique lower(email): the address is already registered. Uniform
    // outward response; the EXISTING holder gets a notice instead (§4.1.2).
    if ((error as { code?: string }).code !== "P2002") throw error;
    const existing = await findUserByEmail(email);
    if (existing) {
      await prisma.$transaction(async (tx) => {
        await recordOutboundEmail(tx, {
          recipient: existing.email,
          subject: "MortMortgage registration attempt",
          body:
            `A registration was attempted with your email address. You already have a ` +
            `MortMortgage account — if this was you, sign in instead (or use "Forgot password"). ` +
            `If it was not you, no action is needed; no account was created or changed.`,
        });
      });
    }
  }
}

/** Uniform failure marker for token flows — routes map to one non-disclosing 400. */
export type TokenFlowResult = { ok: true } | { ok: false };

export async function verifyEmail(rawToken: string, meta: RequestMeta): Promise<TokenFlowResult> {
  return prisma.$transaction(async (tx) => {
    const token = await consumeToken(tx, sha256Hex(rawToken), "verify-email"); // INV-010
    if (!token) return { ok: false } as const;

    await tx.user.updateMany({
      where: { id: token.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });

    await audit(tx, {
      actor: null,
      role: null,
      actionType: "email-verification",
      entityType: "User",
      entityId: token.userId,
      summary: "Email address verified via single-use verification link",
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return { ok: true } as const;
  });
}

export async function resendVerification(
  user: { userId: string; role: UserRole },
  meta: RequestMeta,
): Promise<void> {
  const row = await prisma.user.findUnique({ where: { id: user.userId } });
  if (!row || row.emailVerifiedAt !== null) return; // already verified — Ack is idempotent

  await prisma.$transaction(async (tx) => {
    const { raw } = await issueToken(tx, row.id, "verify-email"); // voids prior open tokens
    await recordOutboundEmail(tx, {
      recipient: row.email,
      subject: VERIFY_EMAIL_SUBJECT,
      body:
        `Here is your new MortMortgage verification link (valid 24 hours, single use):\n` +
        `${appBaseUrl()}/verify-email?token=${raw}\n\n` +
        `Any previously sent verification links are no longer valid.`,
    });
    await audit(tx, {
      actor: user.userId,
      role: row.role,
      actionType: "email-verification",
      entityType: "User",
      entityId: row.id,
      summary: "Verification email re-sent",
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });
}

// ---------------------------------------------------------------------------
// Sign-in with lockout (§4.1.3, §4.1.5, REQ-012 core for task-006)
// ---------------------------------------------------------------------------

export type SignInStatusValue =
  | "signed-in"
  | "mfa-required"
  | "mfa-enrollment-required"
  | "verification-pending";

export type SignInOutcome =
  | { ok: false } // uniform 401 — cause never leaves the service
  | { ok: true; status: SignInStatusValue; redirectTo: string; issued: IssuedSession };

export async function signIn(
  input: { email: string; password: string },
  meta: RequestMeta,
): Promise<SignInOutcome> {
  const user = await findUserByEmail(input.email.trim());

  if (!user) {
    // Unknown email: burn a full-cost verify so timing matches the real-hash path.
    await verifyAgainstDummy(input.password);
    return { ok: false };
  }

  const now = new Date();
  const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
  // ALWAYS run the verify (timing uniformity), even when the outcome is already decided.
  const passwordOk = await verifyPassword(user.passwordHash, input.password);

  if (locked) return { ok: false }; // attempts during lockout do not extend it
  if (user.status !== "active") return { ok: false };

  if (!passwordOk) {
    await recordFailedAttempt(user, meta);
    return { ok: false };
  }

  // Success: counters reset (also clears an expired lockout — §4.1.5 auto-unlock)
  // + session issuance in one tx.
  const hasEnrollment =
    (await prisma.mfaEnrollment.findFirst({
      where: { userId: user.id, status: "enrolled" },
      select: { id: true },
    })) !== null;

  let status: SignInStatusValue;
  let redirectTo: string;
  let mfaPending: boolean;
  if (user.emailVerifiedAt === null) {
    // §4.1.2 / REQ-011: an unverified account may sign in, but "sign in" here means
    // ONLY that it lands on the verification-pending page. The session it receives is
    // PENDING — Session.mfaPendingAt is set exactly as on the two MFA branches below —
    // so getSessionUser (src/lib/auth.ts) refuses it and every protected page and API
    // answers 401 (contracts.md FLOW-002 delivery state). The only surfaces it reaches
    // are the verification-pending ones: GET /api/auth/session,
    // POST /api/auth/resend-verification (both via guardVerificationPending) and
    // POST /api/auth/sign-out.
    status = "verification-pending";
    redirectTo = "/verify-email";
    mfaPending = true;
  } else if (hasEnrollment) {
    status = "mfa-required";
    redirectTo = "/mfa/verify";
    mfaPending = true;
  } else {
    status = "mfa-enrollment-required";
    redirectTo = "/mfa/enroll";
    mfaPending = true;
  }

  const issued = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastSignInAt: now,
      },
    });
    return createSession(tx, {
      userId: user.id,
      mfaPending,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { ok: true, status, redirectTo, issued };
}

/** Failed-attempt counter + §4.1.5 lockout (thresholds from LIVE SystemConfig). */
async function recordFailedAttempt(user: User, meta: RequestMeta): Promise<void> {
  const attempts = await getConfigNumber("password.lockoutAttempts", 5);
  const lockoutMinutes = await getConfigNumber("password.lockoutMinutes", 15);
  const now = new Date();
  const lockExpired = user.lockedUntil !== null && user.lockedUntil.getTime() <= now.getTime();

  await prisma.$transaction(async (tx) => {
    // Expired lockout: this failure starts a NEW consecutive run (auto-unlock).
    const updated = lockExpired
      ? await tx.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 1, lockedUntil: null },
        })
      : await tx.user.update({
          where: { id: user.id },
          data: { failedLoginCount: { increment: 1 } },
        });

    if (updated.failedLoginCount >= attempts && updated.lockedUntil === null) {
      const lockedUntil = new Date(now.getTime() + lockoutMinutes * 60_000);
      await tx.user.update({ where: { id: user.id }, data: { lockedUntil } });
      await audit(tx, {
        actor: null, // not authenticated — the ACTOR is unknown, the TARGET is this user
        role: null,
        actionType: "account-lockout",
        entityType: "User",
        entityId: user.id,
        summary: `Account locked for ${lockoutMinutes} minutes after ${updated.failedLoginCount} consecutive failed sign-in attempts`,
        ip: meta.ip,
        requestId: meta.requestId,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Forgot / reset / change password (§4.1.6, REQ-015, SEC-20)
// ---------------------------------------------------------------------------

export async function forgotPassword(email: string, meta: RequestMeta): Promise<void> {
  const user = await findUserByEmail(email.trim());
  if (!user || user.status !== "active") return; // uniform Ack regardless

  await prisma.$transaction(async (tx) => {
    // §4.8.2 borrower trigger "password reset" (task-036): in-app row via THE
    // notification service. External mode "none" — the token email below IS
    // the external message; linked via OutboundMessage.notificationId.
    const notification = await createNotification(tx, {
      recipientUserId: user.id,
      type: "password-reset",
      title: "Password reset requested",
      body:
        "A password reset link was sent to your email address. " +
        "It is valid for 60 minutes and single-use. If you did not request this, no action is needed.",
      externalDelivery: "none",
    });

    const { raw } = await issueToken(tx, user.id, "reset"); // 60 min, voids prior open tokens
    await recordOutboundEmail(tx, {
      recipient: user.email,
      subject: RESET_SUBJECT,
      body:
        `A password reset was requested for your MortMortgage account.\n\n` +
        `Reset your password within 60 minutes using this single-use link:\n` +
        `${appBaseUrl()}/reset-password?token=${raw}\n\n` +
        `If you did not request this, you can ignore this message — your password is unchanged.`,
      notificationId: notification.id,
    });
    await audit(tx, {
      actor: null,
      role: null,
      actionType: "password-reset",
      entityType: "User",
      entityId: user.id,
      summary: "Password reset link issued",
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });
}

export type PasswordFlowResult =
  | { ok: true }
  | { ok: false; kind: "invalid-token" }
  | { ok: false; kind: "policy"; details: string[] };

export async function resetPassword(
  input: { token: string; newPassword: string },
  meta: RequestMeta,
): Promise<PasswordFlowResult> {
  // Pre-check WITHOUT consuming: policy failures must not burn the token.
  const peeked = await peekToken(prisma, input.token, "reset");
  if (!peeked) return { ok: false, kind: "invalid-token" };

  const details = await validatePasswordPolicy(input.newPassword, {
    field: "newPassword",
    userId: peeked.userId,
  });
  if (details.length > 0) return { ok: false, kind: "policy", details };

  const passwordHash = await hashPassword(input.newPassword);

  return prisma.$transaction(async (tx) => {
    // The atomic claim decides the single winner (INV-010) — the peek above never does.
    const token = await consumeToken(tx, sha256Hex(input.token), "reset");
    if (!token) return { ok: false, kind: "invalid-token" } as const;

    await tx.user.update({
      where: { id: token.userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await tx.passwordHistory.create({ data: { userId: token.userId, passwordHash } });

    // SEC-20: a reset (performed unauthenticated) revokes EVERY active session.
    const revoked = await revokeOtherSessions(tx, token.userId, null);

    await audit(tx, {
      actor: null,
      role: null,
      actionType: "password-reset",
      entityType: "User",
      entityId: token.userId,
      summary: "Password reset via single-use token; all active sessions revoked",
      after: { revokedSessions: revoked },
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return { ok: true } as const;
  });
}

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; kind: "wrong-current-password" }
  | { ok: false; kind: "policy"; details: string[] };

export async function changePassword(
  user: { userId: string; sessionId: string; role: UserRole },
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta,
): Promise<ChangePasswordResult> {
  const row = await prisma.user.findUnique({ where: { id: user.userId } });
  if (!row || !(await verifyPassword(row.passwordHash, input.currentPassword))) {
    return { ok: false, kind: "wrong-current-password" };
  }

  const details = await validatePasswordPolicy(input.newPassword, {
    field: "newPassword",
    userId: user.userId,
  });
  if (details.length > 0) return { ok: false, kind: "policy", details };

  const passwordHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.userId },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
    await tx.passwordHistory.create({ data: { userId: user.userId, passwordHash } });

    // SEC-20: revoke every OTHER session — the session performing the change survives.
    const revoked = await revokeOtherSessions(tx, user.userId, user.sessionId);

    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "password-change",
      entityType: "User",
      entityId: user.userId,
      summary: "Password changed from profile; other active sessions revoked",
      after: { revokedOtherSessions: revoked },
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });
  return { ok: true };
}
