// Pricing-engine simulation — PURE CORE (task-024, INT-005/INT-016, RFP §6.3.4).
//
// Pure function of documented inputs — no clock, no randomness, no I/O.
//
// §6.3.4 mapping:
//   Base rate table (configurable — injectable parameter, defaults below):
//     Conventional 30-yr 6.50% · 20-yr 6.25% · 15-yr 5.85%
//     FHA 30-yr 6.15% · VA 30-yr 6.05% · USDA 30-yr 6.10% · ARM initial 5.95%
//     Fallback INTERPRETATION (documented): a (loanType, term) pair absent from
//     the table (e.g. FHA 15-yr) uses the Conventional rate for that term;
//     a term absent entirely uses Conventional 30-yr.
//   Adjustments (additive, percentage points):
//     credit ≥740: 0.00 · 700–739: +0.25 · 660–699: +0.625 · <660: +1.25
//       (a missing qualifying score is priced at the worst tier — documented
//       conservative interpretation)
//     LTV ≤60: −0.125 · ≤80: 0 · ≤90: +0.25 · ≤97: +0.50 (missing/higher LTV
//       priced in the ≤97 band — documented conservative interpretation)
//     Investment +0.75 · second home +0.375 · 2–4 units +0.25 · condo +0.125 ·
//     manufactured +0.50 · cash-out +0.375
//   Scenarios: par · buy-down (−0.25% for 1.0 point) · lender credit (+0.25%
//     for 1.0% credit). pointsOrCredits sign convention (documented): positive
//     = discount points paid (% of loan), negative = lender credit (% of loan).
//   APR = rate + finance charges spread over the term, finance charges being
//     exactly the documented set: origination 1% + fixed fees $2,850
//     (APR = rate + (charges ÷ loanAmount) × 100 ÷ termYears).
//   FHA adds MIP 0.55%/yr; USDA 0.35%/yr (monthly MI in PITI); VA funding fee
//     2.15% FINANCED (added to the amortized principal).
//   Closing cost estimate = fixed fees + origination + prepaid taxes/insurance.
//     Prepaids INTERPRETATION (documented): 3 months of the provided monthly
//     property taxes + insurance (0 when not provided).
//   Fault trigger: loan amount EXACTLY $999,999 → invalid-response scenario.

import { round2, round3 } from "@/lib/pure/simulations/shared";
import type {
  PricingCheckResult,
  PricingScenario,
  RateAdjustment,
} from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** contracts.json enum literals (LoanType / OccupancyType / PropertyType). */
export interface PricingInput {
  /** LoanDetails.loanType — "conventional" | "fha" | "va" | "usda". */
  loanType: string;
  /** LoanDetails.amortizationType — "adjustable" prices at the ARM initial rate. */
  amortizationType?: string | null;
  /** LoanDetails.loanTermMonths (360 / 240 / 180 in the base table). */
  loanTermMonths: number;
  /** LoanDetails.requestedLoanAmount — $999,999 is the invalid-response trigger. */
  requestedLoanAmount: number;
  /** ASM-003 qualifying credit score (lower of borrowers' middle scores). */
  qualifyingCreditScore?: number | null;
  /** Current LTV percent (e.g. 85 for 85%). */
  ltv?: number | null;
  /** SubjectProperty.occupancy — "primary-residence" | "second-home" | "investment-property". */
  occupancy?: string | null;
  /** SubjectProperty.propertyType — condo/manufactured drive adjustments. */
  propertyType?: string | null;
  /** SubjectProperty.numberOfUnits — 2–4 units drives the +0.25 adjustment. */
  numberOfUnits?: number | null;
  /** Cash-out refinance (loanPurpose "refinance-cash-out" / RefinancePurpose "cash-out"). */
  cashOut?: boolean;
  /** Monthly property taxes (PITI + prepaid closing estimate input). */
  monthlyPropertyTaxes?: number | null;
  /** Monthly homeowners insurance (PITI + prepaid closing estimate input). */
  monthlyInsurance?: number | null;
}

/** Thrown on structurally unusable pricing input. */
export class PricingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingInputError";
  }
}

// ---------------------------------------------------------------------------
// Base rate table (§6.3.4 — "configurable": injectable, defaults documented)
// ---------------------------------------------------------------------------

export interface BaseRateTable {
  /** rate percent by loanType by term months. */
  byLoanType: Record<string, Record<number, number>>;
  /** ARM initial rate percent. */
  armInitial: number;
}

export const DEFAULT_BASE_RATE_TABLE: BaseRateTable = {
  byLoanType: {
    conventional: { 360: 6.5, 240: 6.25, 180: 5.85 },
    fha: { 360: 6.15 },
    va: { 360: 6.05 },
    usda: { 360: 6.1 },
  },
  armInitial: 5.95,
};

/** Resolve the §6.3.4 base rate (with the documented fallback chain). */
export function baseRateFor(input: PricingInput, table: BaseRateTable): number {
  if (input.amortizationType === "adjustable") return table.armInitial;
  const byTerm = table.byLoanType[input.loanType];
  const exact = byTerm?.[input.loanTermMonths];
  if (exact !== undefined) return exact;
  const conventional = table.byLoanType["conventional"] ?? {};
  return conventional[input.loanTermMonths] ?? conventional[360] ?? 6.5;
}

// ---------------------------------------------------------------------------
// Adjustments (§6.3.4, additive percentage points)
// ---------------------------------------------------------------------------

export function creditAdjustmentPct(score: number | null | undefined): number {
  if (typeof score !== "number" || !Number.isFinite(score)) return 1.25; // worst tier (documented)
  if (score >= 740) return 0;
  if (score >= 700) return 0.25;
  if (score >= 660) return 0.625;
  return 1.25;
}

export function ltvAdjustmentPct(ltv: number | null | undefined): number {
  if (typeof ltv !== "number" || !Number.isFinite(ltv)) return 0.5; // ≤97 band (documented)
  if (ltv <= 60) return -0.125;
  if (ltv <= 80) return 0;
  if (ltv <= 90) return 0.25;
  return 0.5; // ≤97 band; >97 also priced here (submission blocks >97 anyway)
}

/** The itemized adjustment stack (§4.6.5 "rate adjustment factors itemized"). */
export function rateAdjustments(input: PricingInput): RateAdjustment[] {
  const adjustments: RateAdjustment[] = [
    { factor: "Credit score", amountPct: creditAdjustmentPct(input.qualifyingCreditScore) },
    { factor: "LTV", amountPct: ltvAdjustmentPct(input.ltv) },
  ];
  if (input.occupancy === "investment-property") {
    adjustments.push({ factor: "Occupancy (investment)", amountPct: 0.75 });
  } else if (input.occupancy === "second-home") {
    adjustments.push({ factor: "Occupancy (second home)", amountPct: 0.375 });
  }
  const units = input.numberOfUnits ?? 1;
  if (units >= 2 && units <= 4) {
    adjustments.push({ factor: "2–4 units", amountPct: 0.25 });
  }
  if (input.propertyType === "condominium") {
    adjustments.push({ factor: "Property type (condo)", amountPct: 0.125 });
  } else if (input.propertyType === "manufactured-home") {
    adjustments.push({ factor: "Property type (manufactured)", amountPct: 0.5 });
  }
  if (input.cashOut === true) {
    adjustments.push({ factor: "Cash-out", amountPct: 0.375 });
  }
  return adjustments;
}

// ---------------------------------------------------------------------------
// Payment / APR math
// ---------------------------------------------------------------------------

/** Standard amortization payment (principal, annual rate %, term months). */
export function monthlyPayment(principal: number, annualRatePct: number, termMonths: number): number {
  if (annualRatePct === 0) return round2(principal / termMonths);
  const r = annualRatePct / 100 / 12;
  return round2((principal * r) / (1 - Math.pow(1 + r, -termMonths)));
}

/** Annual mortgage-insurance rate percent by loan type (FHA 0.55, USDA 0.35). */
export function annualMiRatePct(loanType: string): number {
  if (loanType === "fha") return 0.55;
  if (loanType === "usda") return 0.35;
  return 0;
}

/** VA funding fee (2.15% of the loan, financed) — 0 for other loan types. */
export function vaFundingFee(loanType: string, loanAmount: number): number {
  return loanType === "va" ? round2(loanAmount * 0.0215) : 0;
}

const FIXED_FEES = 2_850;
const ORIGINATION_RATE = 0.01;
/** Documented prepaid interpretation: 3 months of taxes + insurance. */
const PREPAID_MONTHS = 3;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export type PricingSimOutcome =
  /** §6.3.4 fault: loan amount exactly $999,999 (or SIM_FAULT_PRICING=invalid). */
  | { kind: "invalid-response" }
  | { kind: "result"; result: PricingCheckResult };

/** The §6.3.4 invalid-response trigger amount. */
export const PRICING_INVALID_TRIGGER_AMOUNT = 999_999;

export function simulatePricing(
  input: PricingInput,
  table: BaseRateTable = DEFAULT_BASE_RATE_TABLE,
): PricingSimOutcome {
  const loan = input.requestedLoanAmount;
  if (!(typeof loan === "number" && Number.isFinite(loan) && loan > 0)) {
    throw new PricingInputError("pricing simulation requires a positive requested loan amount");
  }
  if (!(Number.isFinite(input.loanTermMonths) && input.loanTermMonths > 0)) {
    throw new PricingInputError("pricing simulation requires a positive loan term");
  }

  // §6.3.4 fault trigger — checked before any math, exactly $999,999.
  if (loan === PRICING_INVALID_TRIGGER_AMOUNT) return { kind: "invalid-response" };

  const baseRate = baseRateFor(input, table);
  const adjustments = rateAdjustments(input);
  const totalAdjustmentPct = adjustments.reduce((sum, a) => sum + a.amountPct, 0);
  const parRate = round3(baseRate + totalAdjustmentPct);

  const termYears = input.loanTermMonths / 12;
  const originationCost = round2(loan * ORIGINATION_RATE);
  const taxes = input.monthlyPropertyTaxes ?? 0;
  const insurance = input.monthlyInsurance ?? 0;
  const prepaids = round2((taxes + insurance) * PREPAID_MONTHS);
  // §6.3.4: "Closing cost estimate = fixed fees + origination + prepaid taxes/insurance."
  const closingCost = round2(FIXED_FEES + originationCost + prepaids);
  // §6.3.4 APR finance charges: origination 1% + fixed fees $2,850 (exactly).
  const financeCharges = originationCost + FIXED_FEES;
  const aprSpreadPct = ((financeCharges / loan) * 100) / termYears;

  // VA funding fee 2.15% is FINANCED — it joins the amortized principal.
  const financedPrincipal = round2(loan + vaFundingFee(input.loanType, loan));
  const monthlyMi = round2((loan * (annualMiRatePct(input.loanType) / 100)) / 12);

  const buildScenario = (
    name: PricingScenario["name"],
    rateDeltaPct: number,
    pointsOrCredits: number,
  ): PricingScenario => {
    const interestRate = round3(parRate + rateDeltaPct);
    const pAndI = monthlyPayment(financedPrincipal, interestRate, input.loanTermMonths);
    return {
      name,
      interestRate,
      apr: round3(interestRate + aprSpreadPct),
      pointsOrCredits,
      monthlyPrincipalInterest: pAndI,
      monthlyPiti: round2(pAndI + taxes + insurance + monthlyMi),
      adjustments,
      originationCost,
      closingCost,
    };
  };

  return {
    kind: "result",
    result: {
      scenarios: [
        buildScenario("par", 0, 0),
        buildScenario("buy-down", -0.25, 1.0), // −0.25% for 1.0 point paid
        buildScenario("lender-credit", 0.25, -1.0), // +0.25% for a 1.0% lender credit
      ],
      baseRate,
    },
  };
}
