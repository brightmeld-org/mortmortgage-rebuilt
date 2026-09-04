// Pure deterministic derivations for the financial-data-aggregator simulation
// (task-014 — REQ-039, INT-006, INT-017, RFP §6.3.5).
//
// EVERYTHING here is a pure function of its inputs (live-state builder rule):
// same username ⇒ same accounts, balances, account numbers, and payroll stream —
// no Math.random, no clock reads, no I/O. The imperative shell
// (src/lib/services/bank-aggregator.ts) supplies latency, env config, and
// persistence.
//
// §6.3.5 mapping:
//   - Accounts derived from hash(username): 2–4 accounts (checking, savings,
//     optional money market / brokerage) with balances $1,800–$85,000.
//     "Brokerage" is mapped onto the CONTRACTED AssetAccountType value `stocks`
//     (contracts.json defines no "brokerage" literal — money-market and stocks
//     are the closest contracted values; nothing is invented).
//   - 90-day bi-weekly payroll deposits equal to (stated base income × 12 / 26)
//     × 0.78 net; employer name equals the Step-3 employer when the username
//     contains "match" (case-insensitive), else a fixed different employer.
//   - averageMonthlyDeposit is the bi-weekly net deposit normalized to monthly
//     (× 26 / 12), i.e. exactly statedBaseMonthlyIncome × 0.78, rounded to cents.

import { fnv1a32 } from "@/lib/pure/address-match";

// ---------------------------------------------------------------------------
// Contracted enum subset used by the simulation (AssetAccountType literals,
// copied verbatim from contracts.json — never invented)
// ---------------------------------------------------------------------------

export const SIMULATED_ACCOUNT_TYPES = ["checking", "savings", "money-market", "stocks"] as const;
export type SimulatedAccountType = (typeof SIMULATED_ACCOUNT_TYPES)[number];

/** Balance bounds per §6.3.5, in cents ($1,800.00 – $85,000.00). */
const MIN_BALANCE_CENTS = 180_000;
const MAX_BALANCE_CENTS = 8_500_000;

/** The fixed non-matching employer (§6.3.5 "else a different employer"). */
export const NON_MATCHING_EMPLOYER = "Cascadia Freight Systems";
/** Fallback when the borrower's real employer IS the fixed non-match name. */
const NON_MATCHING_EMPLOYER_FALLBACK = "Bluepine Staffing Group";

// ---------------------------------------------------------------------------
// Derived accounts
// ---------------------------------------------------------------------------

/**
 * One simulated account. `fullAccountNumber` is INTERNAL ONLY — it exists so
 * import can seal a realistic account number into the task-011 encrypted
 * envelope; it must never appear on the wire or in audit rows (last4 only).
 */
export interface DerivedAccount {
  externalAccountId: string;
  accountType: SimulatedAccountType;
  last4: string;
  /** Dollars with cents precision, within $1,800–$85,000. */
  balance: number;
  /** Deterministic 10-digit account number (internal; encrypted at import). */
  fullAccountNumber: string;
}

/**
 * Derive the 2–4 simulated accounts for a username (§6.3.5 "hash(username)").
 * Deterministic: the same username always yields the identical set; different
 * usernames diverge via FNV-1a. The institution is attached by the caller —
 * the spec keys accounts on the username alone.
 */
export function deriveAccounts(username: string): DerivedAccount[] {
  const seed = fnv1a32(`bank|${username}`);
  const count = 2 + (seed % 3); // ∈ {2, 3, 4}
  const accounts: DerivedAccount[] = [];
  for (let i = 0; i < count; i += 1) {
    const accountHash = fnv1a32(`acct|${username}|${i}`);
    const balanceCents =
      MIN_BALANCE_CENTS + (accountHash % (MAX_BALANCE_CENTS - MIN_BALANCE_CENTS + 1));
    const numberHash = fnv1a32(`acctnum|${username}|${i}`);
    // 10-digit deterministic account number (leading digit never 0).
    const fullAccountNumber = String(1_000_000_000 + (numberHash % 9_000_000_000)).slice(0, 10);
    accounts.push({
      externalAccountId: `ext-${seed.toString(16).padStart(8, "0")}-${i + 1}`,
      accountType: SIMULATED_ACCOUNT_TYPES[i]!,
      last4: fullAccountNumber.slice(-4),
      balance: balanceCents / 100,
      fullAccountNumber,
    });
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// Payroll deposit stream + income evidence
// ---------------------------------------------------------------------------

export interface DerivedPayrollDeposit {
  /** ISO date (YYYY-MM-DD), within the 90-day lookback window. */
  date: string;
  /** Net bi-weekly deposit amount, dollars with cents precision. */
  amount: number;
  employerName: string;
}

export interface DerivedIncomeEvidence {
  employerName: string;
  employerMatch: boolean;
  /** Bi-weekly net deposit normalized to monthly (× 26 / 12), cents precision. */
  averageMonthlyDeposit: number;
  /** The internal 90-day deposit stream the evidence is derived from. */
  deposits: DerivedPayrollDeposit[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * §6.3.5 income evidence, computed from LIVE inputs: the borrower's stated
 * Step-3 base monthly income and employer name (never constants).
 *
 * Returns null when no positive stated base income exists — with no stated
 * income there is no payroll figure to derive, and BankLinkSession.incomeEvidence
 * is optional by contract, so the session simply omits it.
 *
 * @param referenceDate anchors the deterministic 90-day window (callers pass a
 *   fixed date in evidence runs for reproducibility; the service passes "now").
 */
export function deriveIncomeEvidence(
  username: string,
  statedBaseMonthlyIncome: number | null,
  step3EmployerName: string | null,
  referenceDate: Date,
): DerivedIncomeEvidence | null {
  if (statedBaseMonthlyIncome === null || !(statedBaseMonthlyIncome > 0)) return null;

  // (stated base income × 12 / 26) × 0.78 — the net bi-weekly payroll deposit.
  const biWeeklyNet = round2(((statedBaseMonthlyIncome * 12) / 26) * 0.78);
  // Normalized back to monthly (× 26 / 12) ⇒ statedBaseMonthlyIncome × 0.78.
  const averageMonthlyDeposit = round2((biWeeklyNet * 26) / 12);

  const wantsMatch = username.toLowerCase().includes("match");
  const realEmployer = step3EmployerName?.trim() ?? "";
  const employerMatch = wantsMatch && realEmployer.length > 0;
  const employerName = employerMatch
    ? realEmployer
    : realEmployer.toLowerCase() === NON_MATCHING_EMPLOYER.toLowerCase()
      ? NON_MATCHING_EMPLOYER_FALLBACK
      : NON_MATCHING_EMPLOYER;

  // 90-day bi-weekly stream: deposits every 14 days, phase derived from the
  // username hash so different users see different paydays (deterministic).
  const phaseDays = fnv1a32(`payday|${username}`) % 14;
  const deposits: DerivedPayrollDeposit[] = [];
  const dayMs = 86_400_000;
  for (let daysAgo = phaseDays; daysAgo <= 90; daysAgo += 14) {
    const when = new Date(referenceDate.getTime() - daysAgo * dayMs);
    deposits.push({
      date: when.toISOString().slice(0, 10),
      amount: biWeeklyNet,
      employerName,
    });
  }
  deposits.reverse(); // chronological

  return { employerName, employerMatch, averageMonthlyDeposit, deposits };
}

// ---------------------------------------------------------------------------
// Deterministic latency jitter (shared shape with the task-015 SIM convention)
// ---------------------------------------------------------------------------

/**
 * base ± jitter, the offset drawn deterministically from the seed's FNV-1a
 * hash (never Math.random — evidence runs are reproducible).
 */
export function deterministicLatencyMs(seed: string, base: number, jitter: number): number {
  if (jitter === 0) return Math.max(0, base);
  const offset = (fnv1a32(`latency|${seed}`) % (2 * jitter + 1)) - jitter;
  return Math.max(0, base + offset);
}
