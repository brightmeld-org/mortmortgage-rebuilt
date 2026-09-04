// Argon2id password hashing (§4.1.1, REQ-010) — the ONLY module that touches the
// `argon2` package.
//
// Cost tuning: §4.1.1 requires the hash cost tuned to >= 250 ms verify on the
// target host. Measured on the build host (see verification/increment-2/task-006):
// memoryCost 196608 KiB (192 MiB), timeCost 3, parallelism 1 => ~320 ms verify.
// Parameters are compiled constants — they define the stored-hash cost and must
// not be operator-tunable at runtime (a lowered value would silently weaken
// every new hash).
//
// Timing uniformity (§4.1.3 uniform sign-in errors): sign-in must spend the same
// hashing time whether the account exists or not. `verifyAgainstDummy` performs a
// full-cost verify against a precomputed dummy hash for unknown emails, so the
// unknown-email path is indistinguishable by timing from the wrong-password path.

import { argon2id, hash as argon2Hash, verify as argon2Verify, type HashOptions } from "argon2";

const ARGON2_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 196608, // KiB => 192 MiB
  timeCost: 3,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

/** Verify a candidate against a stored hash. Never throws for a well-formed hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    // Malformed stored hash — treat as non-match rather than a 500.
    return false;
  }
}

// Dummy hash for unknown-email timing equalization. Computed once per process at
// first use (same cost parameters as real hashes); the plaintext below never
// matches a submitted password because verification is run against a random
// password, and the RESULT is discarded by the caller anyway.
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    // Random, unguessable content — the verify below is for timing only.
    dummyHashPromise = argon2Hash(
      `dummy-timing-equalizer-${Math.random()}-${Date.now()}`,
      ARGON2_OPTIONS,
    );
  }
  return dummyHashPromise;
}

/**
 * Burn one full-cost verify without any real account (unknown email / any path
 * that must be timing-identical to a real verify). Always returns false.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  await verifyPassword(await dummyHash(), password);
  return false;
}
