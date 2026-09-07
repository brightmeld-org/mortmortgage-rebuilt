// Shared real-provider selector helpers (CH-025 — INV-051, INT-023, §6.1
// row 7 "Zero-key operation").
//
// Every external-integration provider selector follows the SAME fail-fast
// configuration pattern (ratified as INV-051):
//   - <X>_PROVIDER accepts exactly "simulation" | "real"; unset/empty defaults
//     to "simulation"; any other value throws at module load.
//   - "simulation" requires NO environment keys — with no configuration set,
//     behavior is byte-identical to the delivered simulated default and the
//     §7.7 suites run keyless, deterministic, and green.
//   - "real" with missing keys throws at module load with a message naming
//     EVERY missing variable (names only — never credential values).
//   - A "real" selection whose adapter body is not yet wired (Layer B) returns
//     the provider interface's fail-soft/retryable outcome — never a crash.
//
// Consumers: src/lib/services/ocr/index.ts (extended in place — the original
// seam this pattern ratchets), src/lib/services/address/index.ts and
// src/lib/services/bank/index.ts (new CH-025 selector modules).
//
// This module is dependency-free (no prisma, no next/*) so the selector
// modules stay importable from any runtime and from deterministic unit tests
// that pass literal env-shaped records.

/** Plain env-shaped record — unit tests pass literal objects. */
export type ProviderEnv = Record<string, string | undefined>;

/** Single error class for every provider configuration fault (fail fast at load). */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export type ProviderSelection = "simulation" | "real";

/**
 * Parse a `simulation | real` selector variable per INV-051: unset/empty →
 * "simulation" (the zero-key default); anything else than the two literals
 * throws a ProviderConfigError naming the variable.
 */
export function parseProviderSelection(env: ProviderEnv, variable: string): ProviderSelection {
  const raw = (env[variable] ?? "simulation").trim().toLowerCase();
  if (raw === "" || raw === "simulation") return "simulation";
  if (raw === "real") return "real";
  throw new ProviderConfigError(
    `${variable}="${raw}" is not a valid provider selection — use "simulation" (default) or "real"`,
  );
}

/**
 * INV-051 fail-fast key check for an enabled real provider: every required
 * variable must be present and non-blank, else throw ONE error naming every
 * missing variable (names only — never values).
 */
export function requireProviderKeys(
  env: ProviderEnv,
  selectorVariable: string,
  requiredKeys: readonly string[],
): void {
  const missing = requiredKeys.filter((key) => !env[key] || env[key]!.trim() === "");
  if (missing.length > 0) {
    throw new ProviderConfigError(
      `${selectorVariable}=real is enabled but required configuration is missing: ${missing.join(", ")}. ` +
        `Set the missing variable(s) or remove ${selectorVariable} to use the built-in simulation.`,
    );
  }
}
