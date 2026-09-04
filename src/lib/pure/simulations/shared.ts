// Shared deterministic helpers for the §6.3 check simulations (task-024 —
// INT-001, §6.1). Every "random-looking" value in the simulations is drawn
// from FNV-1a hashes of the documented inputs ("no random number generation
// without a documented seed derived from input", §6.1) — identical inputs
// always produce identical outputs.

import { fnv1a32 } from "@/lib/pure/address-match";

export { fnv1a32 };

/** Round to 2 decimal places (currency / percent display values). */
export function round2(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100)) / 100;
}

/** Round to 3 decimal places (rates / APR, matching the ratio precision used repo-wide). */
export function round3(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 1000)) / 1000;
}

/**
 * Deterministic integer in [lo, hi] drawn from the FNV-1a hash of `seed`.
 * The workhorse for every documented range ("utilization Good 12–28%",
 * "inquiries 1–4", "collections 2–3", ...): the range is the documented
 * contract, the position inside it is a pure function of the seed.
 */
export function seededInt(seed: string, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + (fnv1a32(seed) % (hi - lo + 1));
}

/** ISO date (YYYY-MM-DD) `daysAgo` days before the reference date. */
export function isoDaysAgo(referenceDate: Date, daysAgo: number): string {
  return new Date(referenceDate.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Last decimal digit of a numeric string (SSN last-4, ZIP). Returns null when
 * the string carries no trailing digit — the §6.3 scenario keys are defined
 * only for digit-bearing inputs, and callers surface a validation error rather
 * than guessing a tier.
 */
export function lastDigitOf(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /([0-9])[^0-9]*$/.exec(text.trim());
  return match ? Number(match[1]) : null;
}
