// Credit-bureau simulation — PURE CORE (task-024, INT-002/INT-013, RFP §6.3.1).
//
// Pure function of documented inputs: no DB, no fetch, no Date.now (the report
// date and derived history dates come from a referenceDate parameter), no
// Math.random (every in-range value is seeded from the borrower's own input
// per §6.1). Identical inputs ⇒ identical outputs.
//
// §6.3.1 mapping (scenario keyed by the LAST DIGIT of the SSN — available in
// plaintext as ssnLast4 per SEC-1):
//   digit 0–3 → Good tier, base score 740 + digit×10 (740/750/760/770)
//   digit 4–6 → Fair tier, base score 660 + (digit−4)×12 (660/672/684)
//   digit 7–8 → Poor tier, base score 585 + (digit−7)×25 (585/610)
//   digit 9   → service unavailable (503) on the FIRST attempt; Good on retry.
//               INTERPRETATION (documented): §6.3.1 states the retry tier
//               ("Good") but no digit formula for 9 — the Good formula
//               740 + digit×10 would leave the documented 740–770 Good range,
//               so the retry base is pinned to 770, the top of that range.
//   Three bureau scores per borrower: base, base−7, base+5 (Bureau A/B/C —
//   §4.6.5 "labeled Bureau A/B/C in simulation").
//   Tradelines: count 4 + (digit mod 5); utilization by tier (Good 12–28%,
//   Fair 35–55%, Poor 60–95%); collections 0 / 1 / 2–3 with amounts;
//   inquiries 1–4. Positions inside each documented range are seeded from the
//   borrower input (§6.1 documented-seed rule).
//   Partial scenario (SIM_FAULT_CREDIT=partial, applied by the service layer):
//   only two bureau scores returned, the third marked "unavailable".
//   Co-borrower evaluated separately; qualification uses the LOWER of the
//   borrowers' middle scores (ASM-003) — composeCreditCheckResult delegates to
//   the shared qualifyingCreditScore (src/lib/pure/qualification.ts), never a
//   local reimplementation.

import { qualifyingCreditScore, middleBureauScore } from "@/lib/pure/qualification";
import { isoDaysAgo, lastDigitOf, round2, seededInt } from "@/lib/pure/simulations/shared";
import type {
  BureauScore,
  CollectionItem,
  CreditCheckResult,
  CreditRiskTier,
  Tradeline,
} from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** §6.3.1 inputs the caller can provide (SSN via its plaintext last-four). */
export interface CreditBorrowerInput {
  /** Borrower.ssnLast4 — the LAST DIGIT keys the §6.3.1 scenario. */
  ssnLast4: string;
  /** Borrower display name — seed material only (§6.3.1 lists name/DOB as inputs). */
  fullName: string;
  /** ISO date of birth — seed material only. */
  dateOfBirth?: string | null;
}

export interface CreditSimOptions {
  /** 1-based attempt counter — digit 9 returns 503 on attempt 1, Good on ≥2. */
  attempt: number;
  /** SIM_FAULT_CREDIT=partial: two bureau scores, third unavailable. */
  partial: boolean;
  /** Anchors reportDate and all derived history dates (never Date.now here). */
  referenceDate: Date;
}

// ---------------------------------------------------------------------------
// Scenario tiers
// ---------------------------------------------------------------------------

export type CreditScenarioTier = "good" | "fair" | "poor";

/** §6.3.1 base score for an SSN last digit (digit 9 = the pinned retry base). */
export function creditBaseScore(digit: number): number {
  if (digit >= 0 && digit <= 3) return 740 + digit * 10;
  if (digit >= 4 && digit <= 6) return 660 + (digit - 4) * 12;
  if (digit >= 7 && digit <= 8) return 585 + (digit - 7) * 25;
  return 770; // digit 9 retry — Good, pinned to the documented range top (see header)
}

/** §6.3.1 scenario tier for a digit (digit 9 resolves to Good on retry). */
export function creditScenarioTier(digit: number): CreditScenarioTier {
  if (digit <= 3 || digit === 9) return "good";
  if (digit <= 6) return "fair";
  return "poor";
}

/** §4.6.5 display risk tier from the middle score: Good ≥700 / Fair 640–699 / Poor <640. */
export function riskTierForScore(middleScore: number): CreditRiskTier {
  if (middleScore >= 700) return "good";
  if (middleScore >= 640) return "fair";
  return "poor";
}

/** Documented utilization range per tier (§6.3.1). */
const UTILIZATION_RANGE: Record<CreditScenarioTier, readonly [number, number]> = {
  good: [12, 28],
  fair: [35, 55],
  poor: [60, 95],
};

/** Fictional creditor roster — indexed deterministically per tradeline. */
const CREDITORS = [
  "Summit Ridge Card Services",
  "Lakeview Auto Finance",
  "Pinehurst Mortgage Co.",
  "Meridian Education Lending",
  "Harbor Point Bank Card",
  "Foxglove Consumer Credit",
  "Stonebrook Retail Credit",
  "Juniper Personal Lending",
] as const;

const TRADELINE_TYPES = [
  "credit-card",
  "auto-loan",
  "mortgage",
  "student-loan",
  "personal-loan",
] as const;

// ---------------------------------------------------------------------------
// Per-borrower evaluation (§6.3.1 — co-borrower runs this separately)
// ---------------------------------------------------------------------------

/** One borrower's simulated report (before file-level composition). */
export interface BorrowerCreditReport {
  bureauScores: BureauScore[];
  /** Middle of the available bureau scores (lower-of-two on a partial pull). */
  middleScore: number;
  riskTier: CreditRiskTier;
  tradelines: Tradeline[];
  totalUtilizationPct: number;
  collections: CollectionItem[];
  inquiries12mo: number;
  reportDate: string;
}

export type CreditSimOutcome =
  /** §6.3.1 digit 9, first attempt: HTTP-503-shaped, retryable. */
  | { kind: "unavailable-503" }
  | { kind: "report"; report: BorrowerCreditReport };

/** Thrown when the input carries no scenario digit (no trailing digit in ssnLast4). */
export class CreditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditInputError";
  }
}

/**
 * Simulate one borrower's tri-bureau pull (§6.3.1). The co-borrower is
 * evaluated by a SEPARATE call — never merged into the primary's report.
 */
export function simulateBorrowerCredit(
  input: CreditBorrowerInput,
  options: CreditSimOptions,
): CreditSimOutcome {
  const digit = lastDigitOf(input.ssnLast4);
  if (digit === null) {
    throw new CreditInputError("credit simulation requires an SSN last-four with a trailing digit");
  }

  // §6.3.1: last digit 9 → 503 on the first attempt, Good on retry.
  if (digit === 9 && options.attempt <= 1) return { kind: "unavailable-503" };

  const base = creditBaseScore(digit);
  const tier = creditScenarioTier(digit);
  const seed = `credit|${input.ssnLast4}|${input.fullName}|${input.dateOfBirth ?? ""}`;

  // Three bureau scores: base, base−7, base+5 (A/B/C). Partial: third unavailable.
  const bureauScores: BureauScore[] = [
    { bureau: "Bureau A", score: base },
    { bureau: "Bureau B", score: base - 7 },
    options.partial
      ? { bureau: "Bureau C", unavailable: true }
      : { bureau: "Bureau C", score: base + 5 },
  ];
  const middleScore = middleBureauScore(bureauScores);
  if (middleScore === null) throw new CreditInputError("simulated pull produced no scores"); // unreachable

  // Tradelines: count 4 + (digit mod 5); per-row values seeded from input.
  const [utilLo, utilHi] = UTILIZATION_RANGE[tier];
  const tradelineCount = 4 + (digit % 5);
  const tradelines: Tradeline[] = [];
  for (let i = 0; i < tradelineCount; i += 1) {
    const rowSeed = `${seed}|tl|${i}`;
    const type = TRADELINE_TYPES[seededInt(`${rowSeed}|type`, 0, TRADELINE_TYPES.length - 1)]!;
    const revolving = type === "credit-card";
    const creditLimit = revolving
      ? seededInt(`${rowSeed}|limit`, 2_000, 25_000)
      : seededInt(`${rowSeed}|orig`, 8_000, 320_000);
    const utilizationPct = seededInt(`${rowSeed}|util`, utilLo, utilHi);
    const balance = round2((creditLimit * utilizationPct) / 100);
    // Poor tier surfaces a recent late row deterministically (first row).
    const paymentStatus = tier === "poor" && i === 0 ? "30-days-late" : "current";
    tradelines.push({
      creditor: CREDITORS[seededInt(`${rowSeed}|cred`, 0, CREDITORS.length - 1)]!,
      type,
      openedDate: isoDaysAgo(options.referenceDate, seededInt(`${rowSeed}|opened`, 300, 3_000)),
      balance,
      creditLimit,
      utilizationPct,
      paymentStatus,
    });
  }

  // Total utilization inside the documented tier range, seeded from input.
  const totalUtilizationPct = seededInt(`${seed}|totalutil`, utilLo, utilHi);

  // Collections: 0 Good, 1 Fair, 2–3 Poor, with amounts (§6.3.1).
  const collectionCount = tier === "good" ? 0 : tier === "fair" ? 1 : 2 + seededInt(`${seed}|colcount`, 0, 1);
  const collections: CollectionItem[] = [];
  for (let i = 0; i < collectionCount; i += 1) {
    collections.push({
      type: i % 2 === 0 ? "collection" : "charge-off",
      amount: seededInt(`${seed}|col|${i}|amt`, 250, 4_800),
      date: isoDaysAgo(options.referenceDate, seededInt(`${seed}|col|${i}|age`, 90, 1_050)),
    });
  }

  return {
    kind: "report",
    report: {
      bureauScores,
      middleScore,
      riskTier: riskTierForScore(middleScore),
      tradelines,
      totalUtilizationPct,
      collections,
      inquiries12mo: seededInt(`${seed}|inq`, 1, 4), // §6.3.1 "inquiries 1–4"
      reportDate: options.referenceDate.toISOString().slice(0, 10),
    },
  };
}

// ---------------------------------------------------------------------------
// File-level composition (ASM-003)
// ---------------------------------------------------------------------------

/**
 * Compose the wire CreditCheckResult from the primary borrower's report and
 * the co-borrower's separately-evaluated report (when present).
 *
 * The displayed bureau table is the PRIMARY borrower's tri-bureau pull
 * (§4.6.5 shows three bureaus); the co-borrower's separate evaluation feeds
 * `qualifyingScore` = lower of the borrowers' middle scores via the shared
 * ASM-003 implementation (src/lib/pure/qualification.ts — single source).
 *
 * INV-040: `riskTier` is the FILE-level tier — always derived from
 * `qualifyingScore` (never from the primary borrower's `middleScore`, which
 * would badge a 585-scoring co-borrower file "good"). `middleScore` stays the
 * primary borrower's tri-bureau middle score for display only. With no
 * qualifying score (unreachable — a report always carries scores) the primary's
 * middle score is the fallback.
 */
export function composeCreditCheckResult(
  primary: BorrowerCreditReport,
  coBorrower: BorrowerCreditReport | null,
): CreditCheckResult {
  const scoreSets = coBorrower
    ? [primary.bureauScores, coBorrower.bureauScores]
    : [primary.bureauScores];
  const qualifyingScore = qualifyingCreditScore(scoreSets);
  return {
    bureauScores: primary.bureauScores,
    middleScore: primary.middleScore,
    qualifyingScore: qualifyingScore ?? undefined,
    riskTier: riskTierForScore(qualifyingScore ?? primary.middleScore),
    tradelines: primary.tradelines,
    totalUtilizationPct: primary.totalUtilizationPct,
    collections: primary.collections,
    inquiries12mo: primary.inquiries12mo,
    reportDate: primary.reportDate,
  };
}
