// TOTP MFA + recovery codes (task-007). REQ-013, INV-003/INV-010/INV-034,
// VR-015..VR-020, SEC-20.
//
// State model (MfaEnrollment rows per user, MfaStatus enum verbatim):
//   - "enrolled" — the ACTIVE secret. At most one per user (enforced by this
//     service: activation deletes every other row in the same transaction).
//   - "pending"  — an issued-but-unverified secret. NEVER authenticates
//     (INV-034). Regenerable at will; activation requires proving possession
//     via a valid TOTP code.
//   - "reset"    — Supervisor-reset marker (INV-003 path): the old secret no
//     longer authenticates and the user must re-enroll at next sign-in.
//
// INV-034: POST /api/auth/mfa/enroll is REJECTED (409) while an "enrolled" row
// exists — an enrollment call never overwrites an active secret. The ONLY path
// that issues a new secret alongside an active one is re-enrollment
// (password + current-code proof, VR-018..020), and the active secret stays
// authoritative until the new pending secret is verified.
//
// Secrets at rest: AES-256-GCM via the task-002 field-encryption helpers
// (secretCiphertext + secretKeyId columns) — the schema's established pattern.
// Recovery codes: stored ONLY as SHA-256(userId:code) hashes with per-code
// usedAt marks; raw codes exist exactly once, in the endpoint response.
// NOTHING in this module logs secrets or codes.
//
// INV-010 (race-safe consumption): recovery-code consumption runs inside a
// transaction holding a SELECT ... FOR UPDATE row lock on the enrollment row —
// two concurrent uses of the same code serialize on the lock and exactly one
// finds the code unused. TOTP replay is rejected via an atomic compare-and-set
// on lastUsedStep (a given 30s time step authenticates at most once).
//
// Demo seam (task-008 wires the accounts): TOTP verification accepts the fixed
// demo code ONLY when BOTH process.env.DEMO_MODE === "true" AND the user row is
// flagged isDemo. Absent either condition the seam is inert.

import { randomInt } from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import type { MfaEnrollment, Prisma, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/crypto/encryption";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import { sha256Hex } from "@/lib/services/tokens";
import { verifyPassword } from "@/lib/services/password-hash";
import { recordOutboundEmail } from "@/lib/services/outbound";
import { revokeOtherSessions } from "@/lib/services/session";
import type { RequestMeta } from "@/lib/services/auth-account";

// ---------------------------------------------------------------------------
// Constants + uniform failure messages
// ---------------------------------------------------------------------------

const TOTP_ISSUER = "MortMortgage";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
/** ±1 time step tolerance (RFC 6238 resynchronization). */
const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

/**
 * Uniform 401 body for every MFA verification failure cause (wrong code, no
 * enrollment, pending-only secret, replayed step, unknown/consumed recovery
 * code) — byte-identical so the cause never leaks (mirrors §4.1.3 posture).
 */
export const MFA_VERIFY_FAILURE_MESSAGE = "invalid verification code";
/** Uniform 401 for reenroll/regenerate credential failures (VR-018..020 flows). */
export const MFA_REAUTH_FAILURE_MESSAGE = "invalid password or verification code";

/** Fixed demo TOTP code accepted only through the demo seam (see module header). */
export const DEMO_TOTP_CODE = "000000";

function demoBypassAllowed(user: { isDemo: boolean }): boolean {
  return process.env.DEMO_MODE === "true" && user.isDemo;
}

/** Minimal acting-identity slice every operation needs (from the session, never the body). */
export interface MfaActor {
  userId: string;
  sessionId: string;
  role: UserRole;
  email: string;
  isDemo: boolean;
}

// ---------------------------------------------------------------------------
// TOTP primitives
// ---------------------------------------------------------------------------

function totpFor(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

function decryptSecret(row: Pick<MfaEnrollment, "secretCiphertext" | "secretKeyId">): string {
  return decryptField({ ciphertext: row.secretCiphertext, keyId: row.secretKeyId });
}

/**
 * Validate a TOTP code against a secret. Returns the ACCEPTED TIME STEP (for
 * the lastUsedStep replay CAS) or null. The demo seam short-circuits with a
 * sentinel step of null-replay semantics: demo codes are replayable by design
 * (they exist only for scripted demonstrations) and never advance lastUsedStep.
 */
function validateTotp(
  secretBase32: string,
  label: string,
  code: string,
): { ok: true; step: number } | { ok: false } {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return { ok: false };
  const delta = totpFor(secretBase32, label).validate({ token: trimmed, window: TOTP_WINDOW });
  if (delta === null) return { ok: false };
  return { ok: true, step: Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + delta };
}

// ---------------------------------------------------------------------------
// Recovery-code primitives (hashes only at rest)
// ---------------------------------------------------------------------------

/** Unambiguous alphabet (no I/L/O/U/0/1) for operator-typable codes. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

interface RecoveryCodeEntry {
  hash: string;
  /** ISO timestamp when consumed; null while unused (INV-010 mark). */
  usedAt: string | null;
}

function generateRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < 10; i += 1) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Case/hyphen-insensitive canonical form used for hashing and comparison. */
function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Salted with userId so identical codes for different users never share a hash. */
function recoveryCodeHash(userId: string, code: string): string {
  return sha256Hex(`recovery:${userId}:${normalizeRecoveryCode(code)}`);
}

function freshRecoveryCodes(userId: string): { raw: string[]; entries: RecoveryCodeEntry[] } {
  const raw = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  return {
    raw,
    entries: raw.map((code) => ({ hash: recoveryCodeHash(userId, code), usedAt: null })),
  };
}

function parseRecoveryEntries(value: unknown): RecoveryCodeEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is RecoveryCodeEntry =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as RecoveryCodeEntry).hash === "string" &&
      ((item as RecoveryCodeEntry).usedAt === null ||
        typeof (item as RecoveryCodeEntry).usedAt === "string"),
  );
}

/**
 * INV-010 atomic consumption. MUST run on the transaction client of the state
 * change it authorizes. Locks the enrollment row (SELECT ... FOR UPDATE), so
 * concurrent consumers of the SAME code serialize and exactly one wins; the
 * loser re-reads the committed usedAt mark and fails.
 */
async function consumeRecoveryCode(
  tx: AuditTransactionClient,
  enrollmentId: string,
  userId: string,
  rawCode: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<Array<{ id: string; recoveryCodeHashes: unknown }>>`
    SELECT "id", "recoveryCodeHashes" FROM "MfaEnrollment"
    WHERE "id" = ${enrollmentId} AND "status" = 'enrolled'
    FOR UPDATE`;
  if (locked.length === 0) return false;

  const entries = parseRecoveryEntries(locked[0]!.recoveryCodeHashes);
  const hash = recoveryCodeHash(userId, rawCode);
  const entry = entries.find((e) => e.hash === hash);
  if (!entry || entry.usedAt !== null) return false; // unknown or already consumed

  entry.usedAt = new Date().toISOString();
  await tx.mfaEnrollment.update({
    where: { id: enrollmentId },
    data: { recoveryCodeHashes: entries as unknown as Prisma.InputJsonValue },
  });
  return true;
}

// ---------------------------------------------------------------------------
// MfaEnrollInit payload (contracts §A — exact field names)
// ---------------------------------------------------------------------------

export interface MfaEnrollInitPayload {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

async function buildEnrollInit(secretBase32: string, label: string): Promise<MfaEnrollInitPayload> {
  const otpauthUrl = totpFor(secretBase32, label).toString();
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { secret: secretBase32, otpauthUrl, qrCodeDataUrl };
}

async function findEnrolled(userId: string): Promise<MfaEnrollment | null> {
  return prisma.mfaEnrollment.findFirst({ where: { userId, status: "enrolled" } });
}

async function findPending(userId: string): Promise<MfaEnrollment | null> {
  return prisma.mfaEnrollment.findFirst({
    where: { userId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/enroll — issue a pending secret
// ---------------------------------------------------------------------------

export type StartEnrollmentResult =
  | { ok: true; init: MfaEnrollInitPayload }
  | { ok: false; kind: "active-enrollment" };

export async function startEnrollment(
  actor: MfaActor,
  meta: RequestMeta,
): Promise<StartEnrollmentResult> {
  // INV-034: never overwrite an active secret via the enrollment call.
  if (await findEnrolled(actor.userId)) return { ok: false, kind: "active-enrollment" };

  const secretBase32 = new OTPAuth.Secret({ size: 20 }).base32;
  const init = await buildEnrollInit(secretBase32, actor.email);
  const encrypted = encryptField(secretBase32);

  await prisma.$transaction(async (tx) => {
    // A pending secret may be regenerated freely — replace, never accumulate.
    await tx.mfaEnrollment.deleteMany({ where: { userId: actor.userId, status: "pending" } });
    const row = await tx.mfaEnrollment.create({
      data: {
        userId: actor.userId,
        secretCiphertext: new Uint8Array(encrypted.ciphertext),
        secretKeyId: encrypted.keyId,
        status: "pending",
      },
    });
    await audit(tx, {
      actor: actor.userId,
      role: actor.role,
      actionType: "mfa-enrollment",
      entityType: "MfaEnrollment",
      entityId: row.id,
      summary: "TOTP enrollment initiated — pending secret issued (never authenticates until verified)",
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  return { ok: true, init };
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/enroll/verify — activate the pending secret
// ---------------------------------------------------------------------------

export type ActivateEnrollmentResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false };

/**
 * Prove possession of the PENDING secret; on success the pending row becomes
 * the single "enrolled" row (every other enrollment row — an old active secret
 * being re-enrolled away, reset markers, stray pendings — is deleted in the
 * same transaction), ≥10 fresh recovery codes are issued (returned exactly
 * once), and a pre-MFA session is promoted to a full session.
 */
export async function activateEnrollment(
  actor: MfaActor,
  opts: { preMfa: boolean },
  code: string,
  meta: RequestMeta,
): Promise<ActivateEnrollmentResult> {
  const pending = await findPending(actor.userId);
  if (!pending) return { ok: false };

  let step: number | null = null;
  if (demoBypassAllowed(actor) && code.trim() === DEMO_TOTP_CODE) {
    step = null; // demo codes never advance the replay cursor
  } else {
    const verdict = validateTotp(decryptSecret(pending), actor.email, code);
    if (!verdict.ok) return { ok: false };
    step = verdict.step;
  }

  const { raw, entries } = freshRecoveryCodes(actor.userId);

  const activated = await prisma.$transaction(async (tx) => {
    // Conditional claim: if the pending row was replaced/removed concurrently,
    // activation fails rather than resurrecting a stale secret.
    const claimed = await tx.mfaEnrollment.updateMany({
      where: { id: pending.id, status: "pending" },
      data: {
        status: "enrolled",
        verifiedAt: new Date(),
        lastUsedStep: step,
        recoveryCodeHashes: entries as unknown as Prisma.InputJsonValue,
      },
    });
    if (claimed.count === 0) return false;

    // Single-active-enrollment guarantee (also completes re-enrollment: the
    // previously active secret is retired only now — INV-034).
    const removed = await tx.mfaEnrollment.deleteMany({
      where: { userId: actor.userId, id: { not: pending.id } },
    });

    if (opts.preMfa) {
      await tx.session.update({
        where: { id: actor.sessionId },
        data: { mfaPendingAt: null },
      });
    }

    await audit(tx, {
      actor: actor.userId,
      role: actor.role,
      actionType: "mfa-enrollment",
      entityType: "MfaEnrollment",
      entityId: pending.id,
      summary:
        `TOTP enrollment verified and activated; ${RECOVERY_CODE_COUNT} recovery codes issued` +
        (removed.count > 0 ? `; ${removed.count} prior enrollment record(s) retired` : ""),
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return true;
  });

  return activated ? { ok: true, recoveryCodes: raw } : { ok: false };
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/verify — complete the sign-in challenge
// ---------------------------------------------------------------------------

export type MfaChallengeResult =
  | { ok: true; usedRecoveryCode: boolean }
  | { ok: false };

/**
 * Verify the second factor for a PRE-MFA session and promote it to a full
 * session. Only the "enrolled" secret authenticates — a pending secret never
 * does (INV-034). Recovery-code success consumes the code atomically
 * (INV-010) and signals the caller to prompt re-enrollment.
 */
export async function completeMfaChallenge(
  actor: MfaActor,
  input: { code?: string; recoveryCode?: string },
  meta: RequestMeta,
): Promise<MfaChallengeResult> {
  const enrolled = await findEnrolled(actor.userId);
  if (!enrolled) return { ok: false };

  if (input.code !== undefined) {
    let step: number | null = null;
    if (demoBypassAllowed(actor) && input.code.trim() === DEMO_TOTP_CODE) {
      step = null;
    } else {
      const verdict = validateTotp(decryptSecret(enrolled), actor.email, input.code);
      if (!verdict.ok) return { ok: false };
      step = verdict.step;
    }

    const promoted = await prisma.$transaction(async (tx) => {
      if (step !== null) {
        // Replay CAS: a 30s step authenticates at most once.
        const claimed = await tx.mfaEnrollment.updateMany({
          where: {
            id: enrolled.id,
            status: "enrolled",
            OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
          },
          data: { lastUsedStep: step },
        });
        if (claimed.count === 0) return false;
      }
      await tx.session.update({ where: { id: actor.sessionId }, data: { mfaPendingAt: null } });
      return true;
    });
    return promoted ? { ok: true, usedRecoveryCode: false } : { ok: false };
  }

  // Recovery-code path (VR-017): atomic single consumption + promotion in ONE tx,
  // so a failed promotion rolls the consumption back (INV-010 discipline).
  const promoted = await prisma.$transaction(async (tx) => {
    const consumed = await consumeRecoveryCode(
      tx,
      enrolled.id,
      actor.userId,
      input.recoveryCode ?? "",
    );
    if (!consumed) return false;

    await tx.session.update({ where: { id: actor.sessionId }, data: { mfaPendingAt: null } });
    await audit(tx, {
      actor: actor.userId,
      role: actor.role,
      actionType: "mfa-recovery-codes",
      entityType: "MfaEnrollment",
      entityId: enrolled.id,
      summary: "Recovery code consumed at MFA sign-in (single-use); re-enrollment prompted",
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return true;
  });
  return promoted ? { ok: true, usedRecoveryCode: true } : { ok: false };
}

// ---------------------------------------------------------------------------
// Shared re-auth proof for reenroll / regenerate (VR-018..VR-020)
// ---------------------------------------------------------------------------

interface ReauthContext {
  enrolled: MfaEnrollment;
  /** Accepted TOTP step to CAS inside the tx (null = recovery path or demo). */
  step: number | null;
  usedRecoveryCode: boolean;
}

/**
 * Verify currentPassword + exactly one of current TOTP code | unused recovery
 * code, WITHOUT consuming anything yet — consumption/CAS happens inside the
 * caller's transaction via claimReauthFactor. Uniform null on every failure.
 */
async function precheckReauth(
  actor: MfaActor,
  input: { currentPassword: string; code?: string; recoveryCode?: string },
): Promise<ReauthContext | null> {
  const row = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!row || !(await verifyPassword(row.passwordHash, input.currentPassword))) return null;

  const enrolled = await findEnrolled(actor.userId);
  if (!enrolled) return null; // both flows require an ACTIVE enrollment

  if (input.code !== undefined) {
    if (demoBypassAllowed(actor) && input.code.trim() === DEMO_TOTP_CODE) {
      return { enrolled, step: null, usedRecoveryCode: false };
    }
    const verdict = validateTotp(decryptSecret(enrolled), actor.email, input.code);
    if (!verdict.ok) return null;
    return { enrolled, step: verdict.step, usedRecoveryCode: false };
  }
  return { enrolled, step: null, usedRecoveryCode: true };
}

/** Burn the proven factor atomically inside the caller's transaction. */
async function claimReauthFactor(
  tx: AuditTransactionClient,
  actor: MfaActor,
  ctx: ReauthContext,
  input: { code?: string; recoveryCode?: string },
): Promise<boolean> {
  if (ctx.usedRecoveryCode) {
    return consumeRecoveryCode(tx, ctx.enrolled.id, actor.userId, input.recoveryCode ?? "");
  }
  if (ctx.step !== null) {
    const claimed = await tx.mfaEnrollment.updateMany({
      where: {
        id: ctx.enrolled.id,
        status: "enrolled",
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: ctx.step } }],
      },
      data: { lastUsedStep: ctx.step },
    });
    return claimed.count > 0;
  }
  return true; // demo seam — nothing to burn
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/reenroll — issue a new pending secret alongside the active one
// ---------------------------------------------------------------------------

export type ReenrollResult =
  | { ok: true; init: MfaEnrollInitPayload }
  | { ok: false };

export async function initReenroll(
  actor: MfaActor,
  input: { currentPassword: string; code?: string; recoveryCode?: string },
  meta: RequestMeta,
): Promise<ReenrollResult> {
  const ctx = await precheckReauth(actor, input);
  if (!ctx) return { ok: false };

  const secretBase32 = new OTPAuth.Secret({ size: 20 }).base32;
  const init = await buildEnrollInit(secretBase32, actor.email);
  const encrypted = encryptField(secretBase32);

  const issued = await prisma.$transaction(async (tx) => {
    if (!(await claimReauthFactor(tx, actor, ctx, input))) return false;

    // INV-034 semantics: the ACTIVE secret stays untouched and authoritative;
    // only the pending slot is replaced. Activation (enroll/verify) retires it.
    await tx.mfaEnrollment.deleteMany({ where: { userId: actor.userId, status: "pending" } });
    const row = await tx.mfaEnrollment.create({
      data: {
        userId: actor.userId,
        secretCiphertext: new Uint8Array(encrypted.ciphertext),
        secretKeyId: encrypted.keyId,
        status: "pending",
      },
    });
    await audit(tx, {
      actor: actor.userId,
      role: actor.role,
      actionType: "mfa-enrollment",
      entityType: "MfaEnrollment",
      entityId: row.id,
      summary:
        "MFA re-enrollment initiated (password + current factor verified) — new pending secret issued; active secret unchanged until verification",
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return true;
  });

  return issued ? { ok: true, init } : { ok: false };
}

// ---------------------------------------------------------------------------
// POST /api/auth/recovery-codes/regenerate — rotate the recovery-code set
// ---------------------------------------------------------------------------

export type RegenerateResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false };

export async function regenerateRecoveryCodes(
  actor: MfaActor,
  input: { currentPassword: string; code?: string; recoveryCode?: string },
  meta: RequestMeta,
): Promise<RegenerateResult> {
  const ctx = await precheckReauth(actor, input);
  if (!ctx) return { ok: false };

  const { raw, entries } = freshRecoveryCodes(actor.userId);

  const rotated = await prisma.$transaction(async (tx) => {
    if (!(await claimReauthFactor(tx, actor, ctx, input))) return false;

    // Wholesale replacement: EVERY previous code (used or not, including one
    // consumed as the proof factor just above) is invalidated.
    await tx.mfaEnrollment.update({
      where: { id: ctx.enrolled.id },
      data: { recoveryCodeHashes: entries as unknown as Prisma.InputJsonValue },
    });
    await audit(tx, {
      actor: actor.userId,
      role: actor.role,
      actionType: "mfa-recovery-codes",
      entityType: "MfaEnrollment",
      entityId: ctx.enrolled.id,
      summary: `Recovery codes regenerated — ${RECOVERY_CODE_COUNT} new codes issued, all previous codes invalidated`,
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return true;
  });

  return rotated ? { ok: true, recoveryCodes: raw } : { ok: false };
}

// ---------------------------------------------------------------------------
// POST /api/admin/staff/:id/reset-mfa — Supervisor reset (other-users-only, INV-003)
// ---------------------------------------------------------------------------

export type ResetMfaResult =
  | { ok: true }
  | { ok: false; kind: "not-found" | "self" | "no-active-mfa" };

export async function resetMfaForStaff(
  supervisor: MfaActor,
  targetUserId: string,
  meta: RequestMeta,
): Promise<ResetMfaResult> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { mfaEnrollments: { select: { id: true, status: true } } },
  });
  // The /api/admin/staff surface addresses STAFF accounts only.
  if (!target || target.role === "BORROWER") return { ok: false, kind: "not-found" };

  // INV-003: the admin reset path skips possession proof — never on self.
  if (target.id === supervisor.userId) return { ok: false, kind: "self" };

  const hasActive = target.mfaEnrollments.some((e) => e.status === "enrolled");
  if (!hasActive) return { ok: false, kind: "no-active-mfa" };

  await prisma.$transaction(async (tx) => {
    // Pending secrets die with the reset; the active secret becomes a "reset"
    // marker (never authenticates — sign-in routes to mfa-enrollment-required).
    await tx.mfaEnrollment.deleteMany({ where: { userId: target.id, status: "pending" } });
    await tx.mfaEnrollment.updateMany({
      where: { userId: target.id, status: "enrolled" },
      data: { status: "reset", lastUsedStep: null, recoveryCodeHashes: [] },
    });

    // SEC-20 (see src/lib/auth.ts revocation list): a stripped factor must not
    // leave live sessions behind — the target re-authenticates end to end.
    const revoked = await revokeOtherSessions(tx, target.id, null);

    // §D async dispatch: REAL rows, not log lines — in-app Notification (via
    // THE notification service, task-036 §4.8.1; external mode "none" because
    // the tailored account-security email below IS the external message) plus
    // the linked simulated email (sessions are revoked, so in-app alone would
    // only surface at next sign-in).
    const notification = await createNotification(tx, {
      recipientUserId: target.id,
      type: "mfa-reset",
      title: "Multi-factor authentication reset",
      body:
        "A supervisor reset the multi-factor authentication on your account. " +
        "Your previous authenticator and recovery codes no longer work, and you have been " +
        "signed out everywhere. You will be prompted to enroll a new authenticator at your next sign-in.",
      externalDelivery: "none",
    });
    await recordOutboundEmail(tx, {
      recipient: target.email,
      subject: "Your MortMortgage MFA was reset",
      body:
        `Hello ${target.firstName},\n\n` +
        `A supervisor reset the multi-factor authentication on your MortMortgage account. ` +
        `Your previous authenticator app entry and recovery codes are no longer valid, and all of ` +
        `your sessions have been signed out.\n\n` +
        `At your next sign-in you will be prompted to enroll a new authenticator.\n\n` +
        `If you did not expect this, contact your supervisor.`,
      notificationId: notification.id,
    });

    await audit(tx, {
      actor: supervisor.userId, // session identity — never the request body
      role: supervisor.role,
      actionType: "mfa-reset",
      entityType: "User",
      entityId: target.id,
      summary: `Supervisor reset MFA for staff account ${target.email} — re-enrollment required at next sign-in`,
      before: { mfaStatus: "enrolled" },
      after: { mfaStatus: "reset", revokedSessions: revoked },
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  return { ok: true };
}
