// Built-in identity provider (task-008) — the SOLE IdentityProvider
// implementation in the delivered System (§4.1.8 / AC-09).
//
// Deliberately a THIN adapter: every method delegates to the task-006/007
// services unchanged (auth-account, session, mfa, auth resolution), so wiring
// the seam changes NO observable HTTP behavior. The only logic that lives here
// is `provision` — the idempotent find-or-create the seam newly introduces
// (consumed by demo login; the external-IdP swap point for claim mapping).

import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { prisma } from "@/lib/prisma";
import { getMfaFlowSession, getSessionUser, type MfaFlowSession, type SessionUser } from "@/lib/auth";
import { encryptField } from "@/lib/crypto/encryption";
import { audit } from "@/lib/services/audit";
import { hashPassword } from "@/lib/services/password-hash";
import { revokeSession } from "@/lib/services/session";
import { signIn, type RequestMeta, type SignInOutcome } from "@/lib/services/auth-account";
import type { IdentityProvider, ProvisionInput, ProvisionResult } from "@/lib/services/idp/provider";

async function findByEmail(email: string) {
  return prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
}

/**
 * Ensure an ACTIVE MFA enrollment exists for a provisioned user (demo accounts
 * are pre-enrolled, §4.1.4). The secret is random and never disclosed — the
 * demo TOTP seam (task-007) authenticates demo users without it, and a real
 * user provisioned this way would re-enroll through the profile flow.
 * Idempotent: an existing enrolled row is left untouched (INV-034 posture).
 */
async function ensureMfaEnrolled(userId: string): Promise<void> {
  const existing = await prisma.mfaEnrollment.findFirst({
    where: { userId, status: "enrolled" },
    select: { id: true },
  });
  if (existing) return;

  const secretBase32 = new OTPAuth.Secret({ size: 20 }).base32;
  const encrypted = encryptField(secretBase32);
  await prisma.$transaction(async (tx) => {
    // Re-check inside the tx, then replace any non-active rows (pending/reset)
    // so the provisioned state is exactly one enrolled row.
    const race = await tx.mfaEnrollment.findFirst({
      where: { userId, status: "enrolled" },
      select: { id: true },
    });
    if (race) return;
    await tx.mfaEnrollment.deleteMany({ where: { userId } });
    await tx.mfaEnrollment.create({
      data: {
        userId,
        secretCiphertext: new Uint8Array(encrypted.ciphertext),
        secretKeyId: encrypted.keyId,
        status: "enrolled",
        verifiedAt: new Date(),
        recoveryCodeHashes: [],
      },
    });
  });
}

export const builtInProvider: IdentityProvider = {
  name: "built-in",

  // Delegates verbatim to the task-006 credential core (uniform 401 semantics,
  // lockout, pre-MFA session issuance all unchanged).
  signIn(input: { email: string; password: string }, meta: RequestMeta): Promise<SignInOutcome> {
    return signIn(input, meta);
  },

  // The task-006 sign-out body, unchanged: revoke + in-transaction audit,
  // attributed to the session identity (never a request body).
  async signOut(user: SessionUser, meta: RequestMeta): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const revoked = await revokeSession(tx, user.sessionId);
      if (revoked) {
        await audit(tx, {
          actor: user.userId,
          role: user.role,
          actionType: "session-revocation",
          entityType: "Session",
          entityId: user.sessionId,
          summary: "Signed out — session revoked server-side",
          ip: meta.ip,
          requestId: meta.requestId,
        });
      }
    });
  },

  // Delegates to the task-006 resolver (idle/absolute expiry, revocation,
  // pre-MFA rejection, inactive-user rejection — all enforced there).
  sessionLookup(request: Request): Promise<SessionUser | null> {
    return getSessionUser(request);
  },

  /**
   * Idempotent, concurrency-safe find-or-create. The local password is RANDOM
   * per creation (256 bits, argon2-hashed at rest), never returned, never
   * logged — provisioned identities authenticate through their provider path
   * (demo login / upstream IdP), not this credential. The unique lower(email)
   * index (INV-013) decides races: the loser's insert fails P2002 and it
   * re-reads the winner's row, so simultaneous first calls both succeed with
   * one row. Creation is audited, attributed to the created user.
   */
  async provision(input: ProvisionInput, meta: RequestMeta): Promise<ProvisionResult> {
    const email = input.email.trim();

    const existing = await findByEmail(email);
    if (existing) {
      if (input.mfaPreEnrolled) await ensureMfaEnrolled(existing.id);
      return { userId: existing.id, role: existing.role, email: existing.email, created: false };
    }

    const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            passwordHash,
            role: input.role,
            firstName: input.firstName,
            lastName: input.lastName,
            emailVerifiedAt: input.emailVerified ? new Date() : null,
            isDemo: input.isDemo,
            passwordChangedAt: new Date(),
          },
        });
        await audit(tx, {
          actor: created.id, // attributed to the provisioned identity itself
          role: created.role,
          actionType: "account-registration",
          entityType: "User",
          entityId: created.id,
          summary: `${input.isDemo ? "Demo " : ""}${input.role.toLowerCase()} account provisioned via identity-provider hook`,
          ip: meta.ip,
          requestId: meta.requestId,
        });
        return created;
      });
      if (input.mfaPreEnrolled) await ensureMfaEnrolled(user.id);
      return { userId: user.id, role: user.role, email: user.email, created: true };
    } catch (error) {
      // INV-013 unique lower(email): a concurrent provision won the create.
      if ((error as { code?: string }).code !== "P2002") throw error;
      const winner = await findByEmail(email);
      if (!winner) throw error; // genuinely unexpected — surface it
      if (input.mfaPreEnrolled) await ensureMfaEnrolled(winner.id);
      return { userId: winner.id, role: winner.role, email: winner.email, created: false };
    }
  },

  // Delegates to the task-007 pre-MFA-tolerant accessor (10-minute §4.1.4
  // window; full sessions fall through to the general resolver).
  mfaHandoff(request: Request): Promise<MfaFlowSession | null> {
    return getMfaFlowSession(request);
  },
};
