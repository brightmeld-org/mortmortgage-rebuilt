// Public-tools calculation core (task-018 — REQ-043/REQ-044, contracts §E
// algorithmic notes). Pure functions, no I/O — the /api/public/prequalify and
// /api/public/compare handlers are thin wrappers over this module.
//
// §E (verbatim basis):
//   Pre-qualification: `maxMonthlyDebtService = grossMonthlyIncome × 0.43 −
//   monthlyDebtPayments`; rate = §6.3.4 base table rate for the tier;
//   `maxLoanAmount` = present value of that payment over the term at that rate;
//   `maxPurchasePrice = maxLoanAmount + downPaymentAmount`; PITI adds
//   propertyTaxRatePct/12 × price and annualInsurance/12.
//
//   Comparison total cost = total P&I over term + total MI (FHA MIP 0.55%/yr,
//   USDA 0.35%/yr where applicable) + financed fees; best value = lowest total
//   cost.
//
// The tier interest rate is DERIVED FROM the §6.3.4 pricing base table by
// REUSING the task-024 pricing simulation module (src/lib/pure/simulations/
// pricing.ts) — never a duplicated table (acceptance criterion 5):
//   rate = baseRateFor(conventional, term) + creditAdjustmentPct(tier score).
// The calculator collects a credit TIER, not a score; each tier maps to a
// representative score INSIDE that tier's §4.3.1 band (Excellent ≥740 / Good
// 700–739 / Fair 660–699 / Poor <660) so the pricing module's own §6.3.4
// credit-adjustment bands produce the tier's adjustment (documented
// interpretation of "estimated interest rate for the tier (from the pricing
// simulation's base table, §6.3.4)").
//
// Documented interpretations where the contract is silent (see task report):
//   - qualifyIndicator: "likely-to-qualify" when the 43%-DTI budget supports a
//     positive loan amount AND the credit tier is not "poor"; otherwise
//     "review-needed".
//   - propertyTaxRatePct is a PERCENTAGE (1.2 = 1.2%/yr): monthly tax =
//     (pct / 100) × price ÷ 12.
//   - Comparison PITI: the compare inputs carry no tax/insurance fields, so
//     monthly taxes use the §4.3.1 default 1.2%/yr on the purchase price
//     (loanAmount + downPayment) and no homeowner's-insurance component
//     (matches the frame's arithmetic on screen-compare.png); MI monthly is
//     added where applicable.
//   - "financed fees" in comparison total cost = the §6.3.4 VA funding fee
//     (2.15% of the loan, financed) — the only financed fee the §6.3.4 table
//     defines; 0 for other loan types (no fee inputs exist on the tool).

import {
  DEFAULT_BASE_RATE_TABLE,
  annualMiRatePct,
  baseRateFor,
  creditAdjustmentPct,
  monthlyPayment,
  vaFundingFee,
} from "@/lib/pure/simulations/pricing";
import { round2, round3 } from "@/lib/pure/simulations/shared";

// ---------------------------------------------------------------------------
// Shared literals (contracts.json enums — verbatim)
// ---------------------------------------------------------------------------

/** contracts.json enums.CreditTier — verbatim. */
export const CREDIT_TIERS = ["excellent", "good", "fair", "poor"] as const;
export type CreditTier = (typeof CREDIT_TIERS)[number];

/** contracts.json enums.LoanType — verbatim. */
export const LOAN_TYPES = ["conventional", "fha", "va", "usda"] as const;
export type LoanType = (typeof LOAN_TYPES)[number];

/** contracts.json enums.QualifyIndicator — verbatim. */
export type QualifyIndicator = "likely-to-qualify" | "review-needed";

/** §4.3.1 defaults (VR-037 / VR-038 descriptions). */
export const DEFAULT_PROPERTY_TAX_RATE_PCT = 1.2;
export const DEFAULT_ANNUAL_INSURANCE = 1_200;

/** §4.2.7 / §E DTI ceiling used by the calculator (43%). */
export const PREQUAL_DTI_RATIO = 0.43;

/**
 * Representative qualifying score per §4.3.1 tier band — chosen strictly inside
 * each band so the pricing module's §6.3.4 credit-adjustment bands resolve the
 * tier's adjustment (Excellent ≥740 → 0.00, Good 700–739 → +0.25,
 * Fair 660–699 → +0.625, Poor <660 → +1.25).
 */
const TIER_REPRESENTATIVE_SCORE: Record<CreditTier, number> = {
  excellent: 740,
  good: 700,
  fair: 660,
  poor: 600,
};

/**
 * §6.3.4 base-table rate for a credit tier and term (years). Conventional
 * column of the pricing module's DEFAULT_BASE_RATE_TABLE (the calculator states
 * no loan type) plus the tier's additive credit adjustment.
 */
export function tierRateFor(creditTier: CreditTier, termYears: number): number {
  const base = baseRateFor(
    { loanType: "conventional", loanTermMonths: termYears * 12, requestedLoanAmount: 1 },
    DEFAULT_BASE_RATE_TABLE,
  );
  return round3(base + creditAdjustmentPct(TIER_REPRESENTATIVE_SCORE[creditTier]));
}

// ---------------------------------------------------------------------------
// Pre-qualification (§E / REQ-043)
// ---------------------------------------------------------------------------

/** contracts.md §A PrequalifyRequest — exact field names (defaults applied). */
export interface PrequalifyInput {
  grossMonthlyIncome: number;
  monthlyDebtPayments: number;
  creditTier: CreditTier;
  downPaymentAmount: number;
  termYears: number;
  propertyTaxRatePct?: number;
  annualInsurance?: number;
}

/** contracts.md §A PrequalifyResponse — exact field names. */
export interface PrequalifyOutput {
  maxLoanAmount: number;
  estimatedRate: number;
  estimatedMonthlyPiti: number;
  maxPurchasePrice: number;
  qualifyIndicator: QualifyIndicator;
}

/** Present value of a level monthly payment over `termMonths` at annual rate %. */
function presentValueOfPayment(payment: number, annualRatePct: number, termMonths: number): number {
  if (payment <= 0) return 0;
  if (annualRatePct === 0) return payment * termMonths;
  const r = annualRatePct / 100 / 12;
  return (payment * (1 - Math.pow(1 + r, -termMonths))) / r;
}

export function prequalify(input: PrequalifyInput): PrequalifyOutput {
  const termMonths = input.termYears * 12;
  const taxRatePct = input.propertyTaxRatePct ?? DEFAULT_PROPERTY_TAX_RATE_PCT;
  const annualInsurance = input.annualInsurance ?? DEFAULT_ANNUAL_INSURANCE;

  // §E: maxMonthlyDebtService = grossMonthlyIncome × 0.43 − monthlyDebtPayments
  const maxMonthlyDebtService = input.grossMonthlyIncome * PREQUAL_DTI_RATIO - input.monthlyDebtPayments;

  // §E: rate = §6.3.4 base table rate for the tier (via the pricing module).
  const estimatedRate = tierRateFor(input.creditTier, input.termYears);

  // §E: maxLoanAmount = present value of that payment over the term at that rate.
  const maxLoanAmount = round2(presentValueOfPayment(maxMonthlyDebtService, estimatedRate, termMonths));

  // §E: maxPurchasePrice = maxLoanAmount + downPaymentAmount.
  const maxPurchasePrice = round2(maxLoanAmount + input.downPaymentAmount);

  // §E: PITI adds propertyTaxRatePct/12 × price and annualInsurance/12 to the
  // P&I on the max loan (which is maxMonthlyDebtService by construction).
  const principalAndInterest =
    maxLoanAmount > 0 ? monthlyPayment(maxLoanAmount, estimatedRate, termMonths) : 0;
  const monthlyTax = ((taxRatePct / 100) * maxPurchasePrice) / 12;
  const monthlyInsurance = annualInsurance / 12;
  const estimatedMonthlyPiti = round2(principalAndInterest + monthlyTax + monthlyInsurance);

  // Documented interpretation (module header): positive borrowing power at 43%
  // DTI and a non-"poor" tier reads likely-to-qualify; anything else needs review.
  const qualifyIndicator: QualifyIndicator =
    maxLoanAmount > 0 && input.creditTier !== "poor" ? "likely-to-qualify" : "review-needed";

  return { maxLoanAmount, estimatedRate, estimatedMonthlyPiti, maxPurchasePrice, qualifyIndicator };
}

// ---------------------------------------------------------------------------
// Loan comparison (§E / REQ-044)
// ---------------------------------------------------------------------------

/** contracts.md §A CompareScenarioInput — exact field names. */
export interface CompareScenarioInput {
  loanAmount: number;
  interestRate: number;
  termMonths: number;
  downPayment: number;
  loanType: LoanType;
}

/** contracts.md §A CompareScenarioResult — exact field names. */
export interface CompareScenarioResult {
  monthlyPrincipalInterest: number;
  monthlyPiti: number;
  totalInterest: number;
  ltv: number;
  totalCost: number;
  lifetimeMortgageInsurance?: number;
  bestValue: boolean;
}

export function compareScenarios(scenarios: CompareScenarioInput[]): CompareScenarioResult[] {
  const computed = scenarios.map((s) => {
    const monthlyPrincipalInterest = monthlyPayment(s.loanAmount, s.interestRate, s.termMonths);
    const purchasePrice = s.loanAmount + s.downPayment;

    // LTV = loan ÷ (loan + down payment), percent.
    const ltv = purchasePrice > 0 ? round2((s.loanAmount / purchasePrice) * 100) : 0;

    // MI where applicable (FHA MIP 0.55%/yr, USDA 0.35%/yr — pricing module).
    const miRatePct = annualMiRatePct(s.loanType);
    const monthlyMi = round2((s.loanAmount * (miRatePct / 100)) / 12);
    const lifetimeMortgageInsurance = miRatePct > 0 ? round2(monthlyMi * s.termMonths) : undefined;

    // Comparison PITI (documented interpretation, module header): P&I + default
    // 1.2%/yr property tax on the purchase price + monthly MI where applicable.
    const monthlyTax = ((DEFAULT_PROPERTY_TAX_RATE_PCT / 100) * purchasePrice) / 12;
    const monthlyPiti = round2(monthlyPrincipalInterest + monthlyTax + monthlyMi);

    const totalPandI = monthlyPrincipalInterest * s.termMonths;
    const totalInterest = round2(totalPandI - s.loanAmount);

    // §E: total cost = total P&I + total MI (where applicable) + financed fees
    // (VA funding fee 2.15% financed — the only §6.3.4 financed fee).
    const financedFees = vaFundingFee(s.loanType, s.loanAmount);
    const totalCost = round2(totalPandI + (lifetimeMortgageInsurance ?? 0) + financedFees);

    return { monthlyPrincipalInterest, monthlyPiti, totalInterest, ltv, totalCost, lifetimeMortgageInsurance };
  });

  // §E: best value = lowest total cost (single winner; ties → first).
  let bestIndex = 0;
  computed.forEach((r, i) => {
    if (r.totalCost < computed[bestIndex]!.totalCost) bestIndex = i;
  });

  return computed.map((r, i) => ({
    monthlyPrincipalInterest: r.monthlyPrincipalInterest,
    monthlyPiti: r.monthlyPiti,
    totalInterest: r.totalInterest,
    ltv: r.ltv,
    totalCost: r.totalCost,
    ...(r.lifetimeMortgageInsurance !== undefined
      ? { lifetimeMortgageInsurance: r.lifetimeMortgageInsurance }
      : {}),
    bestValue: i === bestIndex,
  }));
}
