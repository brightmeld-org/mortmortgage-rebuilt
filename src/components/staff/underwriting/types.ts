// Client-safe wire types for the Underwriting panel (task-026, REQ-059).
//
// Field names and enum literals are VERBATIM from contracts.json §A
// (UnderwritingResultInfo, UnderwritingResultList, QualificationSummary).
// The per-check result shapes are re-exported from the PURE simulation module
// (src/lib/pure/simulations/check-results.ts — no server imports), which is
// the same module the task-025 service stores verbatim into
// UnderwritingResult.result, so panel types and wire payloads cannot drift.

export type {
  AusCheckResult,
  AusRecommendation,
  AvmCheckResult,
  BureauScore,
  CollectionItem,
  ComparableSale,
  CreditCheckResult,
  CreditRiskTier,
  IncomeCheckResult,
  IncomeVerificationRow,
  MarketTrend,
  PricingCheckResult,
  PricingScenario,
  PricingScenarioName,
  RateAdjustment,
  Tradeline,
} from "@/lib/pure/simulations/check-results";

import type {
  AusCheckResult,
  AusRecommendation,
  AvmCheckResult,
  CreditCheckResult,
  CreditRiskTier,
  IncomeCheckResult,
  PricingCheckResult,
} from "@/lib/pure/simulations/check-results";

/** contracts.json enums.CheckType, verbatim. */
export const CHECK_TYPES = ["credit", "income", "avm", "pricing", "aus"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/** contracts.json enums.CheckStatus, verbatim. */
export type CheckStatus = "running" | "completed" | "error";

/** contracts.json enums.RiskBadge, verbatim. */
export type RiskBadge = "green" | "yellow" | "red";

/** contracts.json enums.QualificationStatus, verbatim. */
export type QualificationStatus = "qualified" | "review" | "not-qualified";

/** contracts §A UnderwritingResultInfo — exact field names. */
export interface UnderwritingResultInfo {
  id: string;
  applicationId: string;
  checkType: CheckType;
  status: CheckStatus;
  provider?: string;
  requestedByName?: string;
  requestedAt: string;
  completedAt?: string;
  summary?: string;
  riskBadge?: RiskBadge;
  isStale: boolean;
  supersededById?: string;
  error?: string;
  credit?: CreditCheckResult;
  income?: IncomeCheckResult;
  avm?: AvmCheckResult;
  pricing?: PricingCheckResult;
  aus?: AusCheckResult;
}

/** contracts §A UnderwritingResultList (GET /api/applications/:id/checks). */
export interface UnderwritingResultList {
  rows: UnderwritingResultInfo[];
}

/** contracts §A QualificationSummary (GET /api/applications/:id/qualification). */
export interface QualificationSummary {
  middleCreditScore?: number;
  creditTier?: CreditRiskTier;
  dti?: number;
  ltv?: number;
  cltv?: number;
  estimatedMonthlyPiti?: number;
  ausRecommendation?: AusRecommendation;
  escalationRequired: boolean;
  escalationCriteriaMet?: string[];
  overallStatus: QualificationStatus;
}

/** Geocoded subject-property position (contracts §A GeoPoint field names). */
export interface SubjectMapPoint {
  latitude: number;
  longitude: number;
  /** Display label for the subject marker popup (e.g. the property address). */
  label?: string;
}
