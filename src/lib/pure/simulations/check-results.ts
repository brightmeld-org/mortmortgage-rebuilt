// contracts.md / contracts.json §A result wire shapes for the five
// underwriting checks (task-024 — INT-002..005, INT-010, INT-013..016,
// INT-021, REQ-059). Field names and enum literals are VERBATIM from
// contracts.json — these objects are stored as-is in
// UnderwritingResult.result by the task-025 orchestration layer.

// ---------------------------------------------------------------------------
// Enums (contracts.json `enums`, exact literals)
// ---------------------------------------------------------------------------

export const CREDIT_RISK_TIERS = ["good", "fair", "poor"] as const;
export type CreditRiskTier = (typeof CREDIT_RISK_TIERS)[number];

export const MARKET_TRENDS = ["rising", "stable", "declining"] as const;
export type MarketTrend = (typeof MARKET_TRENDS)[number];

export const PRICING_SCENARIO_NAMES = ["par", "buy-down", "lender-credit"] as const;
export type PricingScenarioName = (typeof PRICING_SCENARIO_NAMES)[number];

export const AUS_RECOMMENDATIONS = ["approve-eligible", "refer", "refer-with-caution"] as const;
export type AusRecommendation = (typeof AUS_RECOMMENDATIONS)[number];

// ---------------------------------------------------------------------------
// Credit (INT-013, contracts §A CreditCheckResult + children)
// ---------------------------------------------------------------------------

export interface BureauScore {
  bureau: string;
  score?: number;
  unavailable?: boolean;
}

export interface Tradeline {
  creditor: string;
  type: string;
  openedDate?: string;
  balance?: number;
  creditLimit?: number;
  utilizationPct?: number;
  paymentStatus?: string;
}

export interface CollectionItem {
  type: string;
  amount?: number;
  date?: string;
}

export interface CreditCheckResult {
  bureauScores: BureauScore[];
  middleScore?: number;
  qualifyingScore?: number;
  riskTier?: CreditRiskTier;
  tradelines?: Tradeline[];
  totalUtilizationPct?: number;
  collections?: CollectionItem[];
  inquiries12mo?: number;
  reportDate?: string;
}

// ---------------------------------------------------------------------------
// Income (INT-014, contracts §A IncomeCheckResult + IncomeVerificationRow)
// ---------------------------------------------------------------------------

export interface IncomeVerificationRow {
  employerName: string;
  employerVerified: boolean;
  employmentStatus?: string;
  verifiedMonthlyIncome?: number;
  statedMonthlyIncome?: number;
  variancePct?: number;
  confidence?: number;
}

export interface IncomeCheckResult {
  employments: IncomeVerificationRow[];
}

// ---------------------------------------------------------------------------
// AVM (INT-015, contracts §A AvmCheckResult + ComparableSale)
// ---------------------------------------------------------------------------

export interface ComparableSale {
  addressText: string;
  salePrice: number;
  saleDate?: string;
  distanceMiles?: number;
  beds?: number;
  baths?: number;
  squareFeet?: number;
  pricePerSqFt?: number;
  latitude?: number;
  longitude?: number;
}

export interface AvmCheckResult {
  estimatedValue: number;
  valueLow?: number;
  valueHigh?: number;
  confidenceScore?: number;
  marketTrend?: MarketTrend;
  trendPct12mo?: number;
  comparables?: ComparableSale[];
  recomputedLtv?: number;
}

// ---------------------------------------------------------------------------
// Pricing (INT-016, contracts §A PricingCheckResult + children)
// ---------------------------------------------------------------------------

export interface RateAdjustment {
  factor: string;
  amountPct: number;
}

export interface PricingScenario {
  name: PricingScenarioName;
  interestRate: number;
  apr?: number;
  pointsOrCredits?: number;
  monthlyPrincipalInterest?: number;
  monthlyPiti?: number;
  adjustments?: RateAdjustment[];
  originationCost?: number;
  closingCost?: number;
}

export interface PricingCheckResult {
  scenarios: PricingScenario[];
  baseRate?: number;
}

// ---------------------------------------------------------------------------
// AUS (INT-021, contracts §A AusCheckResult)
// ---------------------------------------------------------------------------

export interface AusCheckResult {
  recommendation: AusRecommendation;
  reasons: string[];
  dtiUsed?: number;
  ltvUsed?: number;
  middleScoreUsed?: number;
}
