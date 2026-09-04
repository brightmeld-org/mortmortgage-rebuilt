// Profile self-service (task-006): UserProfile serialization, name/phone edits,
// change-email with re-verification, notification preferences, SMS verification.
// §4.2.12, REQ-041, VR-024..VR-031, INV-010/INV-013.
//
// RECORD-LEVEL SCOPING: every function operates exclusively on the authenticated
// session user's own User row (the userId always comes from the guard's
// SessionUser, never from a request body).

import type { NotificationChannelPreference, User, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/services/audit";
import { verifyPassword } from "@/lib/services/password-hash";
import {
  consumeToken,
  issueSmsCode,
  issueToken,
  sha256Hex,
  smsCodeHash,
  voidOpenTokens,
} from "@/lib/services/tokens";
import { appBaseUrl, recordOutboundEmail, recordOutboundSms } from "@/lib/services/outbound";
import type { RequestMeta } from "@/lib/services/auth-account";

// ---------------------------------------------------------------------------
// UserProfile serializer (contracts.md §A — exact field names)
// ---------------------------------------------------------------------------

export interface UserProfileWire {
  id: string;
  email: string;
  pendingEmail?: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: UserRole;
  notificationChannel?: NotificationChannelPreference;
  smsVerified?: boolean;
  mfaEnrolled: boolean;
  passwordChangedAt?: string;
}

function toUserProfile(user: User, mfaEnrolled: boolean): UserProfileWire {
  const wire: UserProfileWire = {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    notificationChannel: user.notificationChannel,
    smsVerified: user.smsVerifiedAt !== null,
    mfaEnrolled,
  };
  if (user.pendingEmail !== null) wire.pendingEmail = user.pendingEmail;
  if (user.phone !== null) wire.phone = user.phone;
  if (user.passwordChangedAt !== null) wire.passwordChangedAt = user.passwordChangedAt.toISOString();
  return wire;
}

async function hasActiveMfaEnrollment(userId: string): Promise<boolean> {
  const enrollment = await prisma.mfaEnrollment.findFirst({
    where: { userId, status: "enrolled" },
    select: { id: true },
  });
  return enrollment !== null;
}

/** Load the session user's own profile (GET /api/profile and mutation returns). */
export async function getProfile(userId: string): Promise<UserProfileWire | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  return toUserProfile(user, await hasActiveMfaEnrollment(userId));
}

// ---------------------------------------------------------------------------
// PUT /api/profile — name/phone (VR-024..VR-026)
// ---------------------------------------------------------------------------

export async function updateProfile(
  user: { userId: string; role: UserRole },
  input: { firstName: string; lastName: string; phone?: string },
  meta: RequestMeta,
): Promise<UserProfileWire> {
  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: user.userId } });
    const newPhone = input.phone !== undefined && input.phone.trim() !== "" ? input.phone.trim() : null;
    const phoneChanged = newPhone !== before.phone;

    const row = await tx.user.update({
      where: { id: user.userId },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        phone: newPhone,
        // A changed/cleared mobile number is no longer the verified one (VR-030);
        // SMS-dependent channel preferences fall back to email until re-verified.
        ...(phoneChanged ? { smsVerifiedAt: null } : {}),
        ...(phoneChanged && before.notificationChannel !== "email"
          ? { notificationChannel: "email" as NotificationChannelPreference }
          : {}),
      },
    });

    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "profile-update",
      entityType: "User",
      entityId: user.userId,
      summary: "Profile updated (name/phone)",
      before: { firstName: before.firstName, lastName: before.lastName, phone: before.phone },
      after: { firstName: row.firstName, lastName: row.lastName, phone: row.phone },
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return row;
  });
  return toUserProfile(updated, await hasActiveMfaEnrollment(user.userId));
}

// ---------------------------------------------------------------------------
// Change email — old address stays active until the new one verifies (REQ-041)
// ---------------------------------------------------------------------------

export type ChangeEmailResult = { ok: true } | { ok: false; kind: "wrong-current-password" };

export async function changeEmail(
  user: { userId: string; role: UserRole },
  input: { newEmail: string; currentPassword: string },
  meta: RequestMeta,
): Promise<ChangeEmailResult> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
  if (!(await verifyPassword(row.passwordHash, input.currentPassword))) {
    return { ok: false, kind: "wrong-current-password" };
  }

  const newEmail = input.newEmail.trim();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.userId }, data: { pendingEmail: newEmail } });
    const { raw } = await issueToken(tx, user.userId, "verify-new-email");
    // The verification goes to the NEW address; the old email remains the active
    // sign-in identity until this link is consumed. Whether the new address is
    // available is NOT disclosed here — a conflict surfaces only as a generic
    // verification failure at consumption time (INV-013).
    await recordOutboundEmail(tx, {
      recipient: newEmail,
      subject: "Confirm your new MortMortgage email address",
      body:
        `A request was made to change a MortMortgage account's email address to this one.\n\n` +
        `Confirm the change within 24 hours using this single-use link:\n` +
        `${appBaseUrl()}/verify-new-email?token=${raw}\n\n` +
        `Until confirmed, the account keeps its current email address. If you did not ` +
        `request this, ignore this message.`,
    });
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "email-change",
      entityType: "User",
      entityId: user.userId,
      summary: "Email change requested; verification sent to the new address",
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });
  return { ok: true };
}

/**
 * Cancel a pending email change (CH-017, REQ-041) — DELETE /api/profile/change-email.
 *
 * IDEMPOTENT BY CONTRACT: with nothing pending this is a 200 no-op returning the
 * unchanged profile; no 404/409 is contracted. The refreshed UserProfile comes back
 * so the client needs no follow-up GET.
 *
 * Clearing `pendingEmail` alone would leave the mailed link live, so the outstanding
 * verify-new-email token is voided in the SAME transaction via the existing
 * `voidOpenTokens` helper (tokens.ts — the one-live-token-per-purpose mechanism
 * `issueToken` already uses). It runs on BOTH paths: the no-op path must also leave
 * no live link behind. `verifyNewEmail` independently refuses a null pendingEmail,
 * so this is defense in depth, not the only barrier.
 */
export async function cancelEmailChange(
  user: { userId: string; role: UserRole },
  meta: RequestMeta,
): Promise<UserProfileWire> {
  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: user.userId } });
    await voidOpenTokens(tx, user.userId, "verify-new-email");

    const row =
      before.pendingEmail === null
        ? before
        : await tx.user.update({ where: { id: user.userId }, data: { pendingEmail: null } });

    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "email-change",
      entityType: "User",
      entityId: user.userId,
      summary:
        before.pendingEmail === null
          ? "Email change cancellation requested; no change was pending"
          : "Pending email change cancelled; the current address is unchanged",
      before: { pendingEmail: before.pendingEmail },
      after: { pendingEmail: null },
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return row;
  });
  return toUserProfile(updated, await hasActiveMfaEnrollment(user.userId));
}

export type VerifyNewEmailResult = { ok: true } | { ok: false };

/**
 * Consume the verify-new-email token and atomically swap email <- pendingEmail.
 * The unique lower(email) index (INV-013) is the arbiter: a conflicting existing
 * account aborts the transaction (consumption included) and the caller returns
 * the SAME uniform failure as an invalid token — no availability disclosure.
 */
export async function verifyNewEmail(rawToken: string, meta: RequestMeta): Promise<VerifyNewEmailResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const token = await consumeToken(tx, sha256Hex(rawToken), "verify-new-email"); // INV-010
      if (!token) return { ok: false } as const;

      const user = await tx.user.findUniqueOrThrow({ where: { id: token.userId } });
      if (user.pendingEmail === null) return { ok: false } as const;

      await tx.user.update({
        where: { id: user.id },
        data: {
          email: user.pendingEmail,
          pendingEmail: null,
          emailVerifiedAt: new Date(), // the address now on file is the verified one
        },
      });

      await audit(tx, {
        actor: token.userId, // the link was issued to this account's authenticated request
        role: user.role,
        actionType: "email-change",
        entityType: "User",
        entityId: user.id,
        summary: "New email address verified and activated",
        ip: meta.ip,
        requestId: meta.requestId,
      });
      return { ok: true } as const;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { ok: false }; // INV-013 conflict — uniform failure
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Notification preferences (VR-029/VR-030) + SMS verification (borrower)
// ---------------------------------------------------------------------------

export type PreferencesResult =
  | { ok: true; profile: UserProfileWire }
  | { ok: false; details: string[] };

export async function updateNotificationPreferences(
  user: { userId: string; role: UserRole },
  input: { channel: NotificationChannelPreference; mobileNumber?: string },
  meta: RequestMeta,
): Promise<PreferencesResult> {
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: user.userId } });

    const newPhone =
      input.mobileNumber !== undefined ? input.mobileNumber.trim() : before.phone;
    const phoneChanged = newPhone !== before.phone;
    const smsVerified = !phoneChanged && before.smsVerifiedAt !== null;

    // VR-030: SMS-carrying channels require a mobile number that has passed the
    // SMS code flow. A number provided in THIS request cannot be verified yet.
    if ((input.channel === "sms" || input.channel === "both") && (!newPhone || !smsVerified)) {
      return {
        ok: false as const,
        details: [
          "mobileNumber: a verified mobile number is required before the channel may be sms or both (VR-030)",
        ],
      };
    }

    const row = await tx.user.update({
      where: { id: user.userId },
      data: {
        notificationChannel: input.channel,
        phone: newPhone,
        ...(phoneChanged ? { smsVerifiedAt: null } : {}),
      },
    });

    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "notification-preferences",
      entityType: "User",
      entityId: user.userId,
      summary: `Notification channel preference set to "${input.channel}"`,
      before: { notificationChannel: before.notificationChannel, phone: before.phone },
      after: { notificationChannel: row.notificationChannel, phone: row.phone },
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return { ok: true as const, row };
  });

  if (!result.ok) return result;
  return { ok: true, profile: toUserProfile(result.row, await hasActiveMfaEnrollment(user.userId)) };
}

export type SmsStartResult = { ok: true } | { ok: false; details: string[] };

export async function startSmsVerification(
  user: { userId: string; role: UserRole },
  meta: RequestMeta,
): Promise<SmsStartResult> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.user.findUniqueOrThrow({ where: { id: user.userId } });
    if (!row.phone) {
      return {
        ok: false as const,
        details: [
          "mobileNumber: no mobile number on the profile — provide one via notification preferences first",
        ],
      };
    }

    const { code } = await issueSmsCode(tx, user.userId); // hashed at rest, 10-min single use
    await recordOutboundSms(tx, {
      recipient: row.phone,
      body: `Your MortMortgage mobile verification code is ${code}. It expires in 10 minutes.`,
    });
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "sms-verification",
      entityType: "User",
      entityId: user.userId,
      summary: "SMS verification code issued",
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return { ok: true as const };
  });
}

export type SmsConfirmResult =
  | { ok: true; profile: UserProfileWire }
  | { ok: false; details: string[] };

export async function confirmSmsVerification(
  user: { userId: string; role: UserRole },
  code: string,
  meta: RequestMeta,
): Promise<SmsConfirmResult> {
  const confirmed = await prisma.$transaction(async (tx) => {
    // Hash is salted with the session user's id — a code can only confirm its owner.
    const token = await consumeToken(tx, smsCodeHash(user.userId, code.trim()), "sms-verify"); // INV-010
    if (!token || token.userId !== user.userId) return null;

    const row = await tx.user.update({
      where: { id: user.userId },
      data: { smsVerifiedAt: new Date() },
    });
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "sms-verification",
      entityType: "User",
      entityId: user.userId,
      summary: "Mobile number verified via SMS code",
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return row;
  });

  if (!confirmed) {
    return { ok: false, details: ["code: invalid or expired verification code"] };
  }
  return { ok: true, profile: toUserProfile(confirmed, await hasActiveMfaEnrollment(user.userId)) };
}
