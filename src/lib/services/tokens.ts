// Single-use hashed tokens (NFR-011 / SEC-10, INV-010) — verification, new-email
// verification, password reset, and SMS codes, all on the PasswordResetToken table.
//
// Storage: ONLY the SHA-256 hash of the raw secret is persisted (tokenHash has a
// unique index — lookup is indexed, never a scan). The raw token exists solely in
// the returned value, which callers embed in the simulated OutboundMessage body.
// RAW TOKENS MUST NEVER BE LOGGED — no function here logs, and callers must not
// pass raw tokens to any logger or audit summary.
//
// Consumption (INV-010): `consumeToken` is an atomic conditional UPDATE
// (usedAt IS NULL AND expiresAt > now). Two concurrent consumers serialize on the
// row lock; the loser re-evaluates the predicate after the winner commits and
// matches zero rows — exactly one consumer ever succeeds. Run it on the SAME
// transaction client as the state change it authorizes, so a downstream failure
// rolls the consumption back together with the change.

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PasswordResetToken } from "@prisma/client";
import type { AuditTransactionClient } from "@/lib/services/audit";

/** PasswordResetToken.purpose values (CHECK-constrained in the migrations). */
export type TokenPurpose = "reset" | "verify-email" | "verify-new-email" | "invite" | "sms-verify";

export const TOKEN_TTL_MINUTES: Record<Exclude<TokenPurpose, never>, number> = {
  "verify-email": 24 * 60, // §4.1.2: 24 h verification link
  "verify-new-email": 24 * 60, // REQ-041 change-email re-verification
  reset: 60, // §4.1.6: 60-minute reset token
  "sms-verify": 10, // §4.2.12 SMS code — short-lived
  // REQ-063 staff invitation set-password link. The contract states no validity
  // window — 7 days is this build's documented default (task-033).
  invite: 7 * 24 * 60,
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Issue a link-style token (32 random bytes, base64url). Voids the user's other
 * open tokens of the same purpose first (one live token per purpose per user),
 * then inserts the hashed row. Returns the RAW token for the message link only.
 */
export async function issueToken(
  tx: AuditTransactionClient,
  userId: string,
  purpose: Exclude<TokenPurpose, "sms-verify">,
): Promise<{ raw: string; row: PasswordResetToken }> {
  const raw = randomBytes(32).toString("base64url");
  await voidOpenTokens(tx, userId, purpose);
  const row = await tx.passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256Hex(raw),
      purpose,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES[purpose] * 60_000),
    },
  });
  return { raw, row };
}

/**
 * Issue a 6-digit SMS verification code (§4.2.12). The stored hash is salted with
 * the userId so identical codes issued to different users cannot collide on the
 * unique tokenHash index and a code can only ever confirm its own user.
 */
export async function issueSmsCode(
  tx: AuditTransactionClient,
  userId: string,
): Promise<{ code: string; row: PasswordResetToken }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await voidOpenTokens(tx, userId, "sms-verify");
  const row = await tx.passwordResetToken.create({
    data: {
      userId,
      tokenHash: smsCodeHash(userId, code),
      purpose: "sms-verify",
      expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES["sms-verify"] * 60_000),
    },
  });
  return { code, row };
}

export function smsCodeHash(userId: string, code: string): string {
  return sha256Hex(`${userId}:${code}`);
}

/** Mark every open (unused, any expiry) token of a purpose used — issuance replaces. */
export async function voidOpenTokens(
  tx: AuditTransactionClient,
  userId: string,
  purpose: TokenPurpose,
): Promise<void> {
  await tx.passwordResetToken.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });
}

/**
 * Race-safe single consumption (INV-010): atomically claim the token iff it is
 * unused and unexpired. Returns the consumed row (with userId) or null when the
 * token is unknown, expired, already used, or of a different purpose — callers
 * present ONE uniform failure for all of those (no cause disclosure).
 */
export async function consumeToken(
  tx: AuditTransactionClient,
  tokenHash: string,
  purpose: TokenPurpose,
): Promise<PasswordResetToken | null> {
  const claimed = await tx.passwordResetToken.updateMany({
    where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return null;
  return tx.passwordResetToken.findUnique({ where: { tokenHash } });
}

/**
 * Non-consuming pre-check (reset flow: policy validation needs the userId before
 * the token is burned). NEVER a substitute for consumeToken — the atomic claim
 * still decides the single winner.
 */
export async function peekToken(
  client: { passwordResetToken: { findUnique: (args: { where: { tokenHash: string } }) => Promise<PasswordResetToken | null> } },
  rawToken: string,
  purpose: TokenPurpose,
): Promise<PasswordResetToken | null> {
  const row = await client.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
  if (!row || row.purpose !== purpose || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return row;
}
