// Income/employment-verification simulation — PURE CORE (task-024,
// INT-003/INT-014, RFP §6.3.2).
//
// Pure function of documented inputs (employer name, stated base monthly
// income, start date) plus a referenceDate parameter for the 30-day
// probationary window — no clock reads, no randomness.
//
// §6.3.2 mapping:
//   factor digit = (sum of UTF-16 character codes of the employer name) mod 10
//     0–6 → factor 1.00, confidence 95 (verified matches)
//     7   → factor 0.95, confidence 85
//     8   → factor 0.88, confidence 70 (discrepancy)
//     9   → factor 0.70, confidence 50 (material — feeds the §4.6.6
//           variance>20% fraud flag via the 30% variance)
//   Employer name containing "UNVERIFIED" (literal, as documented) →
//   employer not found: employerVerified=false, no verified income, confidence 0.
//   Employment status: "Active" unless the start date falls within 30 days of
//   the reference date → "Probationary".
//   verifiedMonthlyIncome = stated × factor.
//   variancePct — INTERPRETATION (documented): reported as the ABSOLUTE
//   percentage difference |verified − stated| / stated × 100 (0 / 5 / 12 / 30
//   by tier), matching the §4.6.5 badge thresholds ("variance > 10%") and the
//   §4.6.6 fraud rule ("variance > 20%"), which compare magnitudes.

import { round2 } from "@/lib/pure/simulations/shared";
import type { IncomeCheckResult, IncomeVerificationRow } from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One employment record's documented §6.3.2 inputs. */
export interface IncomeEmploymentInput {
  /** EmploymentRecord.employerName — the factor-digit key. */
  employerName: string;
  /** EmploymentRecord.baseMonthlyIncome (stated). */
  statedBaseMonthlyIncome: number | null;
  /** EmploymentRecord.startDate (ISO) — drives the probationary window. */
  startDate?: string | null;
}

// ---------------------------------------------------------------------------
// Factor mapping
// ---------------------------------------------------------------------------

/** §6.3.2 factor digit: (Σ character codes of the employer name) mod 10. */
export function employerFactorDigit(employerName: string): number {
  let sum = 0;
  for (let i = 0; i < employerName.length; i += 1) sum += employerName.charCodeAt(i);
  return sum % 10;
}

export interface IncomeFactorTier {
  factor: number;
  confidence: number;
}

/** §6.3.2 factor/confidence by digit tier (1.00/95, 0.95/85, 0.88/70, 0.70/50). */
export function incomeFactorTier(digit: number): IncomeFactorTier {
  if (digit <= 6) return { factor: 1.0, confidence: 95 };
  if (digit === 7) return { factor: 0.95, confidence: 85 };
  if (digit === 8) return { factor: 0.88, confidence: 70 };
  return { factor: 0.7, confidence: 50 };
}

/** §6.3.2 "employer not found" trigger — literal substring as documented. */
export function isUnverifiedEmployer(employerName: string): boolean {
  return employerName.includes("UNVERIFIED");
}

/** "Probationary" when the start date is within 30 days of the reference date. */
export function isProbationary(startDate: string | null | undefined, referenceDate: Date): boolean {
  if (!startDate) return false;
  const started = Date.parse(startDate);
  if (Number.isNaN(started)) return false;
  const windowStart = referenceDate.getTime() - 30 * 86_400_000;
  return started >= windowStart;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Verify ONE employment row (§6.3.2). */
export function verifyEmployment(
  input: IncomeEmploymentInput,
  referenceDate: Date,
): IncomeVerificationRow {
  const stated =
    typeof input.statedBaseMonthlyIncome === "number" &&
    Number.isFinite(input.statedBaseMonthlyIncome) &&
    input.statedBaseMonthlyIncome >= 0
      ? round2(input.statedBaseMonthlyIncome)
      : undefined;

  // Employer-not-found trigger: verified=false, no verified figure, confidence 0.
  if (isUnverifiedEmployer(input.employerName)) {
    return {
      employerName: input.employerName,
      employerVerified: false,
      employmentStatus: "Not Found",
      statedMonthlyIncome: stated,
      confidence: 0,
    };
  }

  const digit = employerFactorDigit(input.employerName);
  const { factor, confidence } = incomeFactorTier(digit);
  const employmentStatus = isProbationary(input.startDate, referenceDate)
    ? "Probationary"
    : "Active";

  const verifiedMonthlyIncome = stated === undefined ? undefined : round2(stated * factor);
  const variancePct =
    stated === undefined || stated === 0 || verifiedMonthlyIncome === undefined
      ? undefined
      : round2((Math.abs(verifiedMonthlyIncome - stated) / stated) * 100);

  return {
    employerName: input.employerName,
    employerVerified: true,
    employmentStatus,
    verifiedMonthlyIncome,
    statedMonthlyIncome: stated,
    variancePct,
    confidence,
  };
}

/**
 * §6.3.2 income verification across every employment row the caller passes
 * (all borrowers' employments — one IncomeVerificationRow each, same order).
 */
export function simulateIncomeVerification(
  employments: readonly IncomeEmploymentInput[],
  referenceDate: Date,
): IncomeCheckResult {
  return { employments: employments.map((e) => verifyEmployment(e, referenceDate)) };
}
