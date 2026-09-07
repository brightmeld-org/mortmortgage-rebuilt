// OCR-provider selection + fail-fast configuration validation (task-034 —
// §6.1 row 7 "Zero-key operation", INT-019). Mirrors the checks seam
// (src/lib/services/checks/index.ts): consumers import ONLY
// getDocumentOcrProvider() — swapping implementations touches nothing else.
//
// CONFIGURATION (env — the §4.6.11 SystemConfig registry is complete and does
// not grow; §6.1 provider enablement is deployment configuration):
//   OCR_PROVIDER = "simulation" (default — zero-key operation) | "real"
//   OCR_PROVIDER_KIND = "http" (default) | "claude"   (CH-025 — INV-051)
//   A real provider of kind "http" additionally requires OCR_PROVIDER_BASE_URL
//   and OCR_PROVIDER_API_KEY (today's rule, unchanged); kind "claude"
//   (Claude-Vision backend, Layer B) requires OCR_PROVIDER_API_KEY only.
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

import {
  parseProviderSelection,
  requireProviderKeys,
  ProviderConfigError,
} from "@/lib/services/provider-config";
import type { DocumentOcrProvider, OcrOutcome } from "@/lib/services/ocr/provider";
import { runClaudeExtraction } from "@/lib/services/ocr/claude";
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
  // CH-025: delegates to the shared INV-051 helper (message byte-identical to
  // the pre-CH-025 inline check); the OCR-specific error class is preserved
  // for existing consumers.
  try {
    return parseProviderSelection(env, "OCR_PROVIDER");
  } catch (err) {
    if (err instanceof ProviderConfigError) throw new OcrProviderConfigError(err.message);
    throw err;
  }
}

/** CH-025 (INV-051): the real-backend sub-selector — "http" | "claude". */
export type OcrProviderKind = "http" | "claude";

/**
 * Parse OCR_PROVIDER_KIND per the INV-051 pattern: unset/empty → "http" (the
 * pre-CH-025 real-provider rule, unchanged); any value other than the two
 * literals throws at module load.
 */
export function ocrProviderKind(env: OcrProviderEnv = process.env): OcrProviderKind {
  const raw = (env.OCR_PROVIDER_KIND ?? "http").trim().toLowerCase();
  if (raw === "" || raw === "http") return "http";
  if (raw === "claude") return "claude";
  throw new OcrProviderConfigError(
    `OCR_PROVIDER_KIND="${raw}" is not a valid provider kind — use "http" (default) or "claude"`,
  );
}

/** Per-kind required configuration (INV-051): env-variable NAMES only. */
const OCR_KIND_REQUIRED_KEYS: Record<OcrProviderKind, readonly string[]> = {
  http: ["OCR_PROVIDER_BASE_URL", "OCR_PROVIDER_API_KEY"],
  claude: ["OCR_PROVIDER_API_KEY"],
};

/**
 * §6.1 fail-fast validation. Throws OcrProviderConfigError with a clear
 * message when the real provider is enabled without its required
 * configuration. Simulation (the default) requires no configuration at all.
 * CH-025: the kind sub-selector is validated unconditionally (an invalid
 * OCR_PROVIDER_KIND is a configuration error even under simulation), and the
 * required-key set follows the kind: http → BASE_URL + API_KEY (today's rule,
 * byte-identical message), claude → API_KEY only.
 */
export function validateOcrProviderConfig(env: OcrProviderEnv = process.env): void {
  const kind = ocrProviderKind(env);
  if (selection(env) !== "real") return;
  try {
    requireProviderKeys(env, "OCR_PROVIDER", OCR_KIND_REQUIRED_KEYS[kind]);
  } catch (err) {
    if (err instanceof ProviderConfigError) throw new OcrProviderConfigError(err.message);
    throw err;
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

// CH-025 (INV-051): the Claude-Vision backend slot — Layer-B adapter body in
// ocr/claude.ts, behind the ratified interface. Same outcome contract as the
// http-kind slot: no change to DocumentOcrProvider, outcome shapes, latency
// contract, or attribution. Every adapter fault (missing content accessor,
// unreadable content, network, non-2xx, unparseable reply) resolves to a
// fail-soft outcome — never a crash; the belt-and-braces catch here keeps the
// slot's never-throw guarantee even against adapter bugs.
const claudeOcrProvider: DocumentOcrProvider = {
  name: "claude-ocr-provider",
  attribution: REAL_OCR_ATTRIBUTION,
  async run(request): Promise<OcrOutcome> {
    try {
      return await runClaudeExtraction(request);
    } catch {
      return {
        ok: false,
        failure: {
          code: "unavailable",
          message:
            "The configured Claude-Vision OCR provider could not be reached. Retry, use manual " +
            "entry (corrections), or remove OCR_PROVIDER to use the built-in simulation.",
          retryable: true,
        },
        latencyMs: 0,
      };
    }
  },
};

export function getDocumentOcrProvider(): DocumentOcrProvider {
  if (selection(process.env) !== "real") return simulatedOcrProvider;
  return ocrProviderKind(process.env) === "claude" ? claudeOcrProvider : realOcrProvider;
}

/** Attribution for a STORED provider name (serializing historical extractions). */
export function attributionForProvider(providerName: string): string {
  return providerName === SIMULATED_OCR_PROVIDER_NAME
    ? SIMULATED_OCR_ATTRIBUTION
    : REAL_OCR_ATTRIBUTION;
}
