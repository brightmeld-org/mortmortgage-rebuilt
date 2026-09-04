// Request schemas for the task-018 public endpoints — contracts §E VR-032..051
// implemented EXACTLY (no more, no less). Strict objects: unknown fields
// rejected (SEC-18) via the shared strictSchema helper. Field names and enum
// literals mirror contracts.json verbatim.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";
import { CREDIT_TIERS, LOAN_TYPES } from "@/lib/pure/public-tools";

/** PrequalifyRequest — VR-032..038. */
export const prequalifyRequestSchema = strictSchema({
  // VR-032: range 0..1000000
  grossMonthlyIncome: z.number().min(0).max(1_000_000),
  // VR-033: range 0..1000000
  monthlyDebtPayments: z.number().min(0).max(1_000_000),
  // VR-034: enum-value (contracts.json enums.CreditTier)
  creditTier: z.enum(CREDIT_TIERS),
  // VR-035: range 0..100000000
  downPaymentAmount: z.number().min(0).max(100_000_000),
  // VR-036: range 15..30 — "One of 15, 20, or 30."
  termYears: z
    .number()
    .int()
    .min(15)
    .max(30)
    .refine((v) => v === 15 || v === 20 || v === 30, {
      message: "termYears must be one of 15, 20, or 30",
    }),
  // VR-037: range 0..10 — default 1.2%/yr when omitted (applied in the pure module)
  propertyTaxRatePct: z.number().min(0).max(10).optional(),
  // VR-038: range 0..100000 — default $1,200/yr when omitted
  annualInsurance: z.number().min(0).max(100_000).optional(),
});

/** CompareScenarioInput — VR-040..044. */
export const compareScenarioInputSchema = strictSchema({
  // VR-040: range 1000..100000000
  loanAmount: z.number().min(1_000).max(100_000_000),
  // VR-041: range 0..25
  interestRate: z.number().min(0).max(25),
  // VR-042: range 12..480
  termMonths: z.number().int().min(12).max(480),
  // VR-043: range 0..100000000
  downPayment: z.number().min(0).max(100_000_000),
  // VR-044: enum-value (contracts.json enums.LoanType)
  loanType: z.enum(LOAN_TYPES),
});

/** CompareRequest — VR-039 ("At least 3 scenarios required."). */
export const compareRequestSchema = strictSchema({
  scenarios: z
    .array(compareScenarioInputSchema)
    .min(3, { message: "At least 3 scenarios required" }),
});

/** HandoffTokenRequest — VR-045..051 (every field optional per §A). */
export const handoffTokenRequestSchema = strictSchema({
  // VR-045: range 0..1000000
  grossMonthlyIncome: z.number().min(0).max(1_000_000).optional(),
  // VR-046: range 0..1000000
  monthlyDebtPayments: z.number().min(0).max(1_000_000).optional(),
  // VR-047: range 0..100000000
  downPaymentAmount: z.number().min(0).max(100_000_000).optional(),
  // VR-048: range 12..480
  termMonths: z.number().int().min(12).max(480).optional(),
  // VR-049: range 0..100000000
  loanAmount: z.number().min(0).max(100_000_000).optional(),
  // VR-050: range 0..25
  interestRate: z.number().min(0).max(25).optional(),
  // VR-051: enum-value (contracts.json enums.LoanType)
  loanType: z.enum(LOAN_TYPES).optional(),
});
