// Built-in simulated OCR provider (task-034 — the DEFAULT, genuinely-called
// implementation of the src/lib/services/ocr/provider.ts seam).
//
// Imperative-shell duties only: wraps the pure §6.3.7 core
// (src/lib/pure/simulations/ocr.ts) and applies the optional SIM_FAULT_OCR
// env configuration (§6.3 preamble — the §4.6.11 SystemConfig registry is
// complete and does not grow):
//   SIM_FAULT_OCR = none | slow | timeout | unavailable | partial | invalid
//     none        → normal mapping (default; unknown values degrade to none)
//     slow        → the `slow`-trigger latency (45 s) for every file
//     timeout     → failure code "timeout" (retryable)
//     unavailable → failure code "unavailable" (retryable)
//     invalid     → failure code "invalid-response" (retryable)
//     partial     → §6.3.7 documents no partial shape for OCR — degrades to
//                   none (documented, same posture as income/pricing in
//                   src/lib/services/checks/simulated.ts).
//   File-name input triggers (fail/slow/blurry/mismatch) are ALWAYS active
//   regardless of SIM_FAULT_OCR.
//
// All extraction math lives in the pure module; all latency is RETURNED as
// metadata for the worker to apply outside any transaction.

import {
  OCR_SLOW_LATENCY_MS,
  ocrLatencyMs,
  simulateOcrExtraction,
} from "@/lib/pure/simulations/ocr";
import type { DocumentOcrProvider, OcrOutcome } from "@/lib/services/ocr/provider";
import { simFaultOverride } from "@/lib/services/sim-fault-override";

export const SIMULATED_OCR_PROVIDER_NAME = "built-in-simulated-extraction";
/** §4.7 attribution string, verbatim per build-plan task-035 guidance. */
export const SIMULATED_OCR_ATTRIBUTION = "via built-in simulated extraction";

type OcrFault = "none" | "slow" | "timeout" | "unavailable" | "partial" | "invalid";

function configuredFault(): OcrFault {
  // The demo-gated runtime override (task-046 fixture seam) takes precedence
  // over the env var; in production no override can exist (env-only, as before).
  const raw = (simFaultOverride("OCR") ?? process.env.SIM_FAULT_OCR ?? "none").trim().toLowerCase();
  const known: OcrFault[] = ["none", "slow", "timeout", "unavailable", "partial", "invalid"];
  return (known as string[]).includes(raw) ? (raw as OcrFault) : "none";
}

export const simulatedOcrProvider: DocumentOcrProvider = {
  name: SIMULATED_OCR_PROVIDER_NAME,
  attribution: SIMULATED_OCR_ATTRIBUTION,
  async run(request): Promise<OcrOutcome> {
    const fault = configuredFault();
    if (fault === "timeout" || fault === "unavailable" || fault === "invalid") {
      const code = fault === "invalid" ? "invalid-response" : fault;
      return {
        ok: false,
        failure: {
          code,
          message: `Simulated extraction failure (SIM_FAULT_OCR=${fault}). Retry the extraction.`,
          retryable: true,
        },
        latencyMs: ocrLatencyMs(request.fileName, request.contentSha256),
      };
    }

    const outcome = simulateOcrExtraction(request);
    if (fault === "slow" && outcome.latencyMs < OCR_SLOW_LATENCY_MS) {
      return { ...outcome, latencyMs: OCR_SLOW_LATENCY_MS };
    }
    return outcome;
  },
};
