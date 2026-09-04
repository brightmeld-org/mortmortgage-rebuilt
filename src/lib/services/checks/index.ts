// Check-provider selection + INT-001 fail-fast configuration validation
// (task-024). Mirrors the idp seam (src/lib/services/idp/index.ts): consumers
// import ONLY getXCheckProvider() — swapping implementations touches nothing
// else.
//
// CONFIGURATION (env — the §4.6.11 SystemConfig registry is complete and does
// not grow; §6.1 provider enablement is deployment configuration):
//   CHECK_PROVIDER_CREDIT | _INCOME | _AVM | _PRICING | _AUS
//     = "simulation" (default — zero-key operation, §6.1) | "real"
//   A real provider additionally requires:
//     CHECK_PROVIDER_<X>_BASE_URL and CHECK_PROVIDER_<X>_API_KEY
//
// FAIL FAST (INT-001 / §6.1): "Missing configuration for an enabled real
// provider must fail fast at startup with a clear message — never silently
// default to empty credentials." validateCheckProviderConfig() runs at MODULE
// LOAD (the password-policy fail-loud-at-init pattern): any consumer import —
// the task-025 check routes are the boot path — throws before a single check
// can run. Also rejected at startup: an unknown selector value, and
// CHECK_PROVIDER_AUS=real (§6.2 row 9: no real AUS provider exists in this
// version).
//
// REAL-PROVIDER SLOT: interfaces and optional wiring are in scope; vendor
// contracts and credentials are NOT (§11 exclusions). With complete
// configuration the real slot is interface-conformant but returns the §6.2
// documented fallback for an unreachable provider — an "error state with
// Retry" — until vendor-specific wiring is added in its run() method.

import type {
  AusCheckProvider,
  AvmCheckProvider,
  CheckOutcome,
  CreditCheckProvider,
  IncomeCheckProvider,
  PricingCheckProvider,
} from "@/lib/services/checks/provider";
import {
  simulatedAusProvider,
  simulatedAvmProvider,
  simulatedCreditProvider,
  simulatedIncomeProvider,
  simulatedPricingProvider,
} from "@/lib/services/checks/simulated";

export type {
  CheckOutcome,
  CheckFailure,
  CheckFailureCode,
  CreditCheckProvider,
  IncomeCheckProvider,
  AvmCheckProvider,
  PricingCheckProvider,
  AusCheckProvider,
  CreditCheckRequest,
  IncomeCheckRequest,
  AvmCheckRequest,
  PricingCheckRequest,
  AusCheckRequest,
} from "@/lib/services/checks/provider";

// ---------------------------------------------------------------------------
// Configuration validation (INT-001)
// ---------------------------------------------------------------------------

export type CheckIntegration = "CREDIT" | "INCOME" | "AVM" | "PRICING" | "AUS";

export const CHECK_INTEGRATIONS: readonly CheckIntegration[] = [
  "CREDIT",
  "INCOME",
  "AVM",
  "PRICING",
  "AUS",
];

export class CheckProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckProviderConfigError";
  }
}

type ProviderSelection = "simulation" | "real";

/** Plain env-shaped record — evidence scripts pass literal objects. */
export type CheckProviderEnv = Record<string, string | undefined>;

function selection(
  integration: CheckIntegration,
  env: CheckProviderEnv,
): ProviderSelection {
  const raw = (env[`CHECK_PROVIDER_${integration}`] ?? "simulation").trim().toLowerCase();
  if (raw === "" || raw === "simulation") return "simulation";
  if (raw === "real") return "real";
  throw new CheckProviderConfigError(
    `CHECK_PROVIDER_${integration}="${raw}" is not a valid provider selection — use "simulation" (default) or "real"`,
  );
}

/**
 * INT-001 fail-fast validation. Throws CheckProviderConfigError with a clear
 * message when a real provider is enabled without its required configuration.
 * Simulation (the default) requires no configuration at all.
 */
export function validateCheckProviderConfig(env: CheckProviderEnv = process.env): void {
  for (const integration of CHECK_INTEGRATIONS) {
    if (selection(integration, env) !== "real") continue;
    if (integration === "AUS") {
      throw new CheckProviderConfigError(
        "CHECK_PROVIDER_AUS=real is not supported — no real AUS provider exists in this version (§6.2); remove the setting to use the built-in rule-based simulation",
      );
    }
    const missing: string[] = [];
    for (const suffix of ["BASE_URL", "API_KEY"] as const) {
      const key = `CHECK_PROVIDER_${integration}_${suffix}`;
      if (!env[key] || env[key]!.trim() === "") missing.push(key);
    }
    if (missing.length > 0) {
      throw new CheckProviderConfigError(
        `CHECK_PROVIDER_${integration}=real is enabled but required configuration is missing: ${missing.join(
          ", ",
        )}. Set the missing variable(s) or remove CHECK_PROVIDER_${integration} to use the built-in simulation.`,
      );
    }
  }
}

// Fail fast at startup: the first import of this module (the check routes'
// boot path) validates the whole provider configuration before any check runs.
validateCheckProviderConfig();

// ---------------------------------------------------------------------------
// Real-provider slot (interface-conformant; vendor wiring out of scope §11)
// ---------------------------------------------------------------------------

function realProviderOutcome<T>(integration: CheckIntegration): CheckOutcome<T> {
  return {
    ok: false,
    failure: {
      code: "unavailable",
      message:
        `The configured real ${integration.toLowerCase()} provider could not be reached — ` +
        "vendor-specific wiring is not part of this delivery (§11). Retry, or remove " +
        `CHECK_PROVIDER_${integration} to use the built-in simulation.`,
      retryable: true,
      httpStatus: 503,
    },
    latencyMs: 0,
  };
}

const realCreditProvider: CreditCheckProvider = {
  name: "real-credit-bureau",
  async run() {
    return realProviderOutcome("CREDIT");
  },
};
const realIncomeProvider: IncomeCheckProvider = {
  name: "real-income-verification",
  async run() {
    return realProviderOutcome("INCOME");
  },
};
const realAvmProvider: AvmCheckProvider = {
  name: "real-avm",
  async run() {
    return realProviderOutcome("AVM");
  },
};
const realPricingProvider: PricingCheckProvider = {
  name: "real-pricing-engine",
  async run() {
    return realProviderOutcome("PRICING");
  },
};

// ---------------------------------------------------------------------------
// Selection (validated above — selection() cannot throw for a validated env)
// ---------------------------------------------------------------------------

export function getCreditCheckProvider(): CreditCheckProvider {
  return selection("CREDIT", process.env) === "real" ? realCreditProvider : simulatedCreditProvider;
}

export function getIncomeCheckProvider(): IncomeCheckProvider {
  return selection("INCOME", process.env) === "real" ? realIncomeProvider : simulatedIncomeProvider;
}

export function getAvmCheckProvider(): AvmCheckProvider {
  return selection("AVM", process.env) === "real" ? realAvmProvider : simulatedAvmProvider;
}

export function getPricingCheckProvider(): PricingCheckProvider {
  return selection("PRICING", process.env) === "real" ? realPricingProvider : simulatedPricingProvider;
}

export function getAusCheckProvider(): AusCheckProvider {
  // validateCheckProviderConfig rejects CHECK_PROVIDER_AUS=real at startup.
  return simulatedAusProvider;
}
