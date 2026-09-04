// Runtime SIM_FAULT_* override (task-046 fixture seam — test-only).
//
// The simulated integrations read their fault mode from SIM_FAULT_<INTEGRATION>
// environment variables (task-048/simulation-mapping.md §Fault Scenarios).
// Environment variables cannot change against a running server, so the
// sanctioned test-only seam (POST /api/test/fixtures, op "set-simulation-fault"
// — task-046/test-fixtures-contract.md) needs a process-level override the
// fault readers consult BEFORE the env var.
//
// PRODUCTION POSTURE: the override is settable ONLY through setSimFaultOverride,
// which throws unless the process is non-production AND DEMO_MODE === "true" —
// the same gate that makes the fixtures route absent (404). In production the
// map can never hold a value, so every reader falls through to the env var and
// behavior is exactly as before this module existed.
//
// The map lives on globalThis (same posture as src/lib/prisma.ts): Next dev can
// evaluate a shared module once per route bundle, and the override set through
// the fixtures route must be visible to the check/OCR routes' bundles too.

/** Env-style fault values (SIM_FAULT_* vocabulary — "invalid", not "invalid-response"). */
export type SimFaultOverrideValue =
  | "none"
  | "slow"
  | "timeout"
  | "unavailable"
  | "partial"
  | "invalid";

const globalForSimFault = globalThis as unknown as {
  simFaultOverrides?: Map<string, SimFaultOverrideValue>;
};

function overrides(): Map<string, SimFaultOverrideValue> {
  if (!globalForSimFault.simFaultOverrides) {
    globalForSimFault.simFaultOverrides = new Map();
  }
  return globalForSimFault.simFaultOverrides;
}

function seamGateOpen(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.DEMO_MODE === "true";
}

/**
 * The effective override for one integration key ("CREDIT", "INCOME", "AVM",
 * "PRICING", "AUS", "OCR"), or undefined when none is set (env var governs).
 * Cheap and safe to call from any fault reader — in production the map is
 * always empty.
 */
export function simFaultOverride(integration: string): SimFaultOverrideValue | undefined {
  return overrides().get(integration);
}

/**
 * Set the effective fault mode for one integration for the remainder of the
 * process ("none" restores normal behavior by overriding any env value with
 * the no-fault mode). Test seam ONLY: throws when the demo gate is closed, so
 * this is dead code in a production build.
 */
export function setSimFaultOverride(integration: string, value: SimFaultOverrideValue): void {
  if (!seamGateOpen()) {
    throw new Error(
      "setSimFaultOverride is a demo-mode test seam (task-046/test-fixtures-contract.md) and is unavailable in this environment",
    );
  }
  overrides().set(integration, value);
}
