// Simulated check providers (task-024 — the DEFAULT, genuinely-called
// implementations of the src/lib/services/checks/provider.ts seams).
//
// Imperative-shell duties only: read SIM_FAULT / SIM_LATENCY env configuration
// and wrap the pure cores in src/lib/pure/simulations/. All math lives in the
// pure modules; all latency is RETURNED as metadata (deterministic jitter from
// the input via deterministicLatencyMs — never Math.random) for the caller to
// apply outside any transaction, per the bank-aggregator convention.
//
// FAULT CONFIGURATION (§6.3 preamble):
//   SIM_FAULT_<INTEGRATION> = none | slow | timeout | unavailable | partial | invalid
//   Integrations: CREDIT, INCOME, AVM, PRICING, AUS (env vars — the §4.6.11
//   SystemConfig registry is complete and does not grow).
//     none        → normal mapping (default; unknown values degrade to none)
//     slow        → SIM_LATENCY_<X>_SLOW_EXTRA_MS (default 8000) added to latency
//     timeout     → failure code "timeout" (client shows timeout + Retry, §6.3)
//     unavailable → failure code "unavailable" (503-shaped, Retry)
//     partial     → documented partial shapes only: CREDIT (two bureaus, third
//                   unavailable) and AVM (value + confidence 40, no comparables).
//                   §6.3 documents no partial shape for income/pricing/AUS —
//                   there it degrades to none (documented).
//     invalid     → failure code "invalid-response" (Retry)
//   Input triggers are ALWAYS active regardless of SIM_FAULT: SSN last digit 9
//   (credit 503-then-retry), ZIP last digit 9 (AVM partial), loan amount
//   exactly $999,999 (pricing invalid-response).
//
// LATENCY DEFAULTS (§6.3.1–6.3.4, 6.3.9):
//   credit 1200±600 · income 900±400 · AVM 1500±500 · pricing 700±300 ·
//   AUS 2500±500 — env-overridable via SIM_LATENCY_<X>_BASE_MS / _JITTER_MS.

import { deterministicLatencyMs } from "@/lib/pure/bank-simulation";
import { simFaultOverride } from "@/lib/services/sim-fault-override";
import {
  composeCreditCheckResult,
  simulateBorrowerCredit,
  type BorrowerCreditReport,
} from "@/lib/pure/simulations/credit";
import { simulateIncomeVerification } from "@/lib/pure/simulations/income";
import { simulateAvm } from "@/lib/pure/simulations/avm";
import { simulatePricing } from "@/lib/pure/simulations/pricing";
import { simulateAus } from "@/lib/pure/simulations/aus";
import type {
  AusCheckProvider,
  AvmCheckProvider,
  CheckFailure,
  CheckOutcome,
  CreditCheckProvider,
  IncomeCheckProvider,
  PricingCheckProvider,
} from "@/lib/services/checks/provider";

// ---------------------------------------------------------------------------
// Env configuration
// ---------------------------------------------------------------------------

export type SimIntegration = "CREDIT" | "INCOME" | "AVM" | "PRICING" | "AUS";

export const SIM_FAULT_VALUES = [
  "none",
  "slow",
  "timeout",
  "unavailable",
  "partial",
  "invalid",
] as const;
export type SimFault = (typeof SIM_FAULT_VALUES)[number];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Read the effective fault at call time (unknown values degrade to "none").
 * The demo-gated runtime override (task-046 fixture seam) takes precedence
 * over the SIM_FAULT_<INTEGRATION> env var; in production no override can
 * exist and the env var alone governs, exactly as before.
 */
export function checkSimFault(integration: SimIntegration): SimFault {
  const raw = (simFaultOverride(integration) ?? process.env[`SIM_FAULT_${integration}`] ?? "none")
    .trim()
    .toLowerCase();
  return (SIM_FAULT_VALUES as readonly string[]).includes(raw) ? (raw as SimFault) : "none";
}

/** §6.3 default base/jitter per integration (ms). */
const LATENCY_DEFAULTS: Record<SimIntegration, { base: number; jitter: number }> = {
  CREDIT: { base: 1_200, jitter: 600 },
  INCOME: { base: 900, jitter: 400 },
  AVM: { base: 1_500, jitter: 500 },
  PRICING: { base: 700, jitter: 300 },
  AUS: { base: 2_500, jitter: 500 },
};

/**
 * Deterministic latency for one simulated call: base ± jitter (jitter offset
 * seeded from the request input), plus the slow-extra when SIM_FAULT=slow.
 */
export function checkLatencyMs(integration: SimIntegration, seed: string): number {
  const defaults = LATENCY_DEFAULTS[integration];
  const base = envInt(`SIM_LATENCY_${integration}_BASE_MS`, defaults.base);
  const jitter = envInt(`SIM_LATENCY_${integration}_JITTER_MS`, defaults.jitter);
  const extra =
    checkSimFault(integration) === "slow"
      ? envInt(`SIM_LATENCY_${integration}_SLOW_EXTRA_MS`, 8_000)
      : 0;
  return deterministicLatencyMs(`check|${integration}|${seed}`, base, jitter) + extra;
}

// ---------------------------------------------------------------------------
// Config-selected fault → failure mapping (shared by all five providers)
// ---------------------------------------------------------------------------

function configuredFailure(integration: SimIntegration): CheckFailure | null {
  switch (checkSimFault(integration)) {
    case "timeout":
      return {
        code: "timeout",
        message: "The provider did not respond in time. Retry the check.",
        retryable: true,
      };
    case "unavailable":
      return {
        code: "unavailable",
        message: "The provider is temporarily unavailable (503). Retry the check.",
        retryable: true,
        httpStatus: 503,
      };
    case "invalid":
      return {
        code: "invalid-response",
        message: "The provider returned an unreadable response. Retry the check.",
        retryable: true,
      };
    default:
      return null; // none / slow / partial do not fail the call
  }
}

// ---------------------------------------------------------------------------
// Simulated providers
// ---------------------------------------------------------------------------

const CREDIT_503: CheckFailure = {
  code: "unavailable",
  message: "Credit bureau service unavailable (503). Retry the check.",
  retryable: true,
  httpStatus: 503,
};

export const simulatedCreditProvider: CreditCheckProvider = {
  name: "simulated-credit-bureau",
  async run(request) {
    const seed = `${request.primary.ssnLast4}|${request.coBorrower?.ssnLast4 ?? ""}`;
    const latencyMs = checkLatencyMs("CREDIT", seed);
    const failure = configuredFailure("CREDIT");
    if (failure) return { ok: false, failure, latencyMs };

    const partial = checkSimFault("CREDIT") === "partial";
    const options = { attempt: request.attempt, partial, referenceDate: request.referenceDate };

    // Each borrower is evaluated SEPARATELY (§6.3.1); a digit-9 borrower fails
    // the pull with 503 on the first attempt, succeeds on retry.
    const primaryOutcome = simulateBorrowerCredit(request.primary, options);
    if (primaryOutcome.kind === "unavailable-503") return { ok: false, failure: CREDIT_503, latencyMs };

    let coReport: BorrowerCreditReport | null = null;
    if (request.coBorrower) {
      const coOutcome = simulateBorrowerCredit(request.coBorrower, options);
      if (coOutcome.kind === "unavailable-503") return { ok: false, failure: CREDIT_503, latencyMs };
      coReport = coOutcome.report;
    }

    return { ok: true, result: composeCreditCheckResult(primaryOutcome.report, coReport), latencyMs };
  },
};

export const simulatedIncomeProvider: IncomeCheckProvider = {
  name: "simulated-income-verification",
  async run(request) {
    const seed = request.employments.map((e) => e.employerName).join("|");
    const latencyMs = checkLatencyMs("INCOME", seed);
    const failure = configuredFailure("INCOME");
    if (failure) return { ok: false, failure, latencyMs };
    return {
      ok: true,
      result: simulateIncomeVerification(request.employments, request.referenceDate),
      latencyMs,
    };
  },
};

export const simulatedAvmProvider: AvmCheckProvider = {
  name: "simulated-avm",
  async run(request) {
    const latencyMs = checkLatencyMs("AVM", `${request.subject.zip}|${request.subject.addressText}`);
    const failure = configuredFailure("AVM");
    if (failure) return { ok: false, failure, latencyMs };
    const partial = checkSimFault("AVM") === "partial";
    return {
      ok: true,
      result: simulateAvm(request.subject, { partial, referenceDate: request.referenceDate }),
      latencyMs,
    };
  },
};

export const simulatedPricingProvider: PricingCheckProvider = {
  name: "simulated-pricing-engine",
  async run(request) {
    const latencyMs = checkLatencyMs(
      "PRICING",
      `${request.pricing.loanType}|${request.pricing.requestedLoanAmount}`,
    );
    const failure = configuredFailure("PRICING");
    if (failure) return { ok: false, failure, latencyMs };
    const outcome = simulatePricing(request.pricing);
    if (outcome.kind === "invalid-response") {
      // §6.3.4 input trigger: loan amount exactly $999,999.
      return {
        ok: false,
        failure: {
          code: "invalid-response",
          message: "The pricing engine returned an invalid response. Retry the check.",
          retryable: true,
        },
        latencyMs,
      };
    }
    return { ok: true, result: outcome.result, latencyMs };
  },
};

export const simulatedAusProvider: AusCheckProvider = {
  name: "simulated-aus",
  async run(request) {
    const latencyMs = checkLatencyMs(
      "AUS",
      `${request.aus.middleScore ?? ""}|${request.aus.dti ?? ""}|${request.aus.ltv ?? ""}`,
    );
    const failure = configuredFailure("AUS");
    if (failure) return { ok: false, failure, latencyMs };
    return { ok: true, result: simulateAus(request.aus), latencyMs };
  },
};
