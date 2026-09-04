// OCR-provider selection + fail-fast configuration validation (task-034 —
// §6.1 row 7 "Zero-key operation", INT-019). Mirrors the checks seam
// (src/lib/services/checks/index.ts): consumers import ONLY
// getDocumentOcrProvider() — swapping implementations touches nothing else.
//
// CONFIGURATION (env — the §4.6.11 SystemConfig registry is complete and does
// not grow; §6.1 provider enablement is deployment configuration):
//   OCR_PROVIDER = "simulation" (default — zero-key operation) | "real"
//   A real provider additionally requires OCR_PROVIDER_BASE_URL and
//   OCR_PROVIDER_API_KEY.
//
// FAIL FAST (§6.1): "Missing configuration for an enabled real provider must
// fail fast at startup with a clear message — never silently default to empty
// credentials." validateOcrProviderConfig() runs at MODULE LOAD — the OCR
// routes and the document-ocr worker are the boot path.
//
// REAL-PROVIDER SLOT (AMB-001/Q4): the interface-conformant adapter accepts
// the SAME output structure (OcrFieldResult rows). Vendor contracts and
// credentials are NOT part of this delivery — with complete configuration the
// slot returns the §6.2 documented fallback ("manual entry by staff": a
// retryable failure the staff panel surfaces with Retry, corrections always
// available) until vendor-specific wiring is added in its run() method.
// Delivery is evaluated on the simulation.

import type { DocumentOcrProvider, OcrOutcome } from "@/lib/services/ocr/provider";
import {
  SIMULATED_OCR_ATTRIBUTION,
  SIMULATED_OCR_PROVIDER_NAME,
  simulatedOcrProvider,
} from "@/lib/services/ocr/simulated";

export type {
  DocumentOcrProvider,
  OcrExtractionRequest,
  OcrOutcome,
  OcrEnteredData,
  OcrExtractedField,
} from "@/lib/services/ocr/provider";
export { SIMULATED_OCR_ATTRIBUTION, SIMULATED_OCR_PROVIDER_NAME };

export class OcrProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrProviderConfigError";
  }
}

/** Plain env-shaped record — evidence scripts pass literal objects. */
export type OcrProviderEnv = Record<string, string | undefined>;

function selection(env: OcrProviderEnv): "simulation" | "real" {
  const raw = (env.OCR_PROVIDER ?? "simulation").trim().toLowerCase();
  if (raw === "" || raw === "simulation") return "simulation";
  if (raw === "real") return "real";
  throw new OcrProviderConfigError(
    `OCR_PROVIDER="${raw}" is not a valid provider selection — use "simulation" (default) or "real"`,
  );
}

/**
 * §6.1 fail-fast validation. Throws OcrProviderConfigError with a clear
 * message when the real provider is enabled without its required
 * configuration. Simulation (the default) requires no configuration at all.
 */
export function validateOcrProviderConfig(env: OcrProviderEnv = process.env): void {
  if (selection(env) !== "real") return;
  const missing: string[] = [];
  for (const key of ["OCR_PROVIDER_BASE_URL", "OCR_PROVIDER_API_KEY"] as const) {
    if (!env[key] || env[key]!.trim() === "") missing.push(key);
  }
  if (missing.length > 0) {
    throw new OcrProviderConfigError(
      `OCR_PROVIDER=real is enabled but required configuration is missing: ${missing.join(", ")}. ` +
        "Set the missing variable(s) or remove OCR_PROVIDER to use the built-in simulation.",
    );
  }
}

// Fail fast at startup: the first import of this module (the OCR routes / the
// document-ocr worker boot path) validates the configuration before any
// extraction can run.
validateOcrProviderConfig();

/** §4.7 attribution for the configured-AI-provider slot, verbatim per task-035 guidance. */
export const REAL_OCR_ATTRIBUTION = "via configured AI provider";

const realOcrProvider: DocumentOcrProvider = {
  name: "real-ocr-provider",
  attribution: REAL_OCR_ATTRIBUTION,
  async run(): Promise<OcrOutcome> {
    return {
      ok: false,
      failure: {
        code: "unavailable",
        message:
          "The configured real OCR/AI provider could not be reached — vendor-specific wiring is " +
          "not part of this delivery. Retry, use manual entry (corrections), or remove " +
          "OCR_PROVIDER to use the built-in simulation.",
        retryable: true,
      },
      latencyMs: 0,
    };
  },
};

export function getDocumentOcrProvider(): DocumentOcrProvider {
  return selection(process.env) === "real" ? realOcrProvider : simulatedOcrProvider;
}

/** Attribution for a STORED provider name (serializing historical extractions). */
export function attributionForProvider(providerName: string): string {
  return providerName === SIMULATED_OCR_PROVIDER_NAME
    ? SIMULATED_OCR_ATTRIBUTION
    : REAL_OCR_ATTRIBUTION;
}
