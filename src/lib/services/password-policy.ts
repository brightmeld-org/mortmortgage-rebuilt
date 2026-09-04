// Password policy (§4.1.5, REQ-014, VR-004/VR-012/VR-014/VR-023).
//
// | Rule              | Default                                   | Source                      |
// |-------------------|-------------------------------------------|-----------------------------|
// | Minimum length    | 12 (configurable >= 8)                    | password.minLength (no seeded
// |                   |                                           | row => default 12 applies)  |
// | Character classes | >= 3 of upper/lower/digit/symbol          | fixed (not configurable)    |
// | History           | last N (default 5) not reusable           | password.historyDepth       |
// | Common passwords  | reject the published top-10,000 list      | fixed (ASM-010)             |
//
// Expiry (password.expiryDays) is a sign-in-time PROMPT concern driven by
// UserProfile.passwordChangedAt (§4.1.5 "180 days; user prompted to change at
// sign-in"), enforced by isUserPasswordExpired() below and consumed at the point a
// full session is granted (POST /api/auth/mfa/verify) — LENS-018 wired this; the
// config key formerly had zero consumers. SignInStatus carries no dedicated value,
// so the prompt is surfaced via redirectTo exactly as the MFA re-enrollment prompt
// is (/profile?mfaReenroll=1). Lockout (§4.1.5) lives in the sign-in flow.
//
// The common-password list is vendored at src/lib/data/common-passwords.txt
// (one per line — the published open top-10,000 list per ASM-010) and loaded once
// at module init. Comparison is case-insensitive: "Password123!" varying only by
// case from a listed entry is still a listed password.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { getConfigNumber } from "@/lib/http/config";
import { verifyPassword } from "@/lib/services/password-hash";

const DEFAULT_MIN_LENGTH = 12;
const HARD_MIN_LENGTH = 8; // §4.1.5: configurable, but never below 8
const DEFAULT_HISTORY_DEPTH = 5;

// ---------------------------------------------------------------------------
// Common-password list — loaded once at module init (10,000 entries)
// ---------------------------------------------------------------------------

function loadCommonPasswords(): ReadonlySet<string> {
  const path = join(process.cwd(), "src", "lib", "data", "common-passwords.txt");
  const set = new Set<string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const entry = line.trim();
    if (entry.length > 0) set.add(entry.toLowerCase());
  }
  if (set.size < 9000) {
    // The vendored list is a delivery artifact; a truncated file silently weakens
    // the control, so fail loudly at startup instead.
    throw new Error(
      `common-passwords.txt loaded only ${set.size} entries — expected the top-10,000 list`,
    );
  }
  return set;
}

const COMMON_PASSWORDS: ReadonlySet<string> = loadCommonPasswords();

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

function characterClassCount(password: string): number {
  let upper = 0;
  let lower = 0;
  let digit = 0;
  let symbol = 0;
  for (const ch of password) {
    if (ch >= "A" && ch <= "Z") upper = 1;
    else if (ch >= "a" && ch <= "z") lower = 1;
    else if (ch >= "0" && ch <= "9") digit = 1;
    else symbol = 1;
  }
  return upper + lower + digit + symbol;
}

/**
 * Validate a candidate password against the §4.1.5 policy. Returns the
 * contract-style `details[]` strings (empty array = pass). When `userId` is
 * given, history reuse is checked against the last `password.historyDepth`
 * PasswordHistory hashes (each set-time writes one row, so the window includes
 * the current password). The field name in details is the caller's request
 * field ("password" or "newPassword").
 */
export async function validatePasswordPolicy(
  candidate: string,
  options: { field: string; userId?: string },
): Promise<string[]> {
  const { field, userId } = options;
  const details: string[] = [];

  const configuredMin = await getConfigNumber("password.minLength", DEFAULT_MIN_LENGTH);
  const minLength = Math.max(HARD_MIN_LENGTH, configuredMin);
  if (candidate.length < minLength) {
    details.push(`${field}: must be at least ${minLength} characters`);
  }

  if (characterClassCount(candidate) < 3) {
    details.push(
      `${field}: must contain at least 3 of: uppercase letter, lowercase letter, digit, symbol`,
    );
  }

  if (COMMON_PASSWORDS.has(candidate.toLowerCase())) {
    details.push(`${field}: is too common — choose a password not on the common-password list`);
  }

  // History reuse (only worth the argon2 verifies when the cheap rules pass).
  if (details.length === 0 && userId) {
    const depth = await getConfigNumber("password.historyDepth", DEFAULT_HISTORY_DEPTH);
    if (depth > 0) {
      const recent = await prisma.passwordHistory.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: depth,
        select: { passwordHash: true },
      });
      for (const row of recent) {
        if (await verifyPassword(row.passwordHash, candidate)) {
          details.push(`${field}: must not match any of your last ${depth} passwords`);
          break;
        }
      }
    }
  }

  return details;
}

const DEFAULT_EXPIRY_DAYS = 180; // §4.6.11 / REQ-014 default
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * REQ-014 / §4.1.5: a password expires password.expiryDays (default 180) after it
 * was last set, and the user is prompted to change it at sign-in. Returns true when
 * the user's current password is past that horizon.
 *
 * - expiryDays <= 0 disables expiry (returns false) — a configurable off switch.
 * - passwordChangedAt === null is treated as EXPIRED (fail closed): an undated
 *   credential must not outlive the policy. Every real set-time writes the field
 *   (auth-account, built-in.provision, the seeder), so this is a defence, not a
 *   normal state.
 */
export async function isUserPasswordExpired(userId: string): Promise<boolean> {
  const expiryDays = await getConfigNumber("password.expiryDays", DEFAULT_EXPIRY_DAYS);
  if (!Number.isFinite(expiryDays) || expiryDays <= 0) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordChangedAt: true },
  });
  if (!user) return false;
  if (user.passwordChangedAt === null) return true;
  return Date.now() - user.passwordChangedAt.getTime() > expiryDays * DAY_MS;
}
