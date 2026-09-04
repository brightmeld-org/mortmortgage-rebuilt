// Document-OCR provider interface (task-034 — INT-008, INT-019, §6.1 row 7).
//
// Mirrors the underwriting-check seam (src/lib/services/checks/provider.ts):
// one interface, two implementations — the built-in deterministic SIMULATION
// (default; genuinely called in the production code path) and an optional real
// OCR/AI provider slot enabled by configuration (index.ts). Per AMB-001/Q4 the
// real-provider path is an interface-conformant adapter accepting the SAME
// output structure (OcrFieldResult rows + raw text) — delivery is evaluated on
// the simulation.
//
// LATENCY CONTRACT (bank-aggregator convention): providers never sleep. Every
// outcome carries `latencyMs` — computed deterministically from the input by
// the simulation (§6.3.7: 4 s ± 2; `slow` → 45 s) — and the CALLER (the
// document-ocr worker) applies it with a non-blocking sleep OUTSIDE any
// database transaction.

import type {
  OcrEnteredData,
  OcrExtractedField,
  OcrSimulationFailure,
} from "@/lib/pure/simulations/ocr";

export type { OcrEnteredData, OcrExtractedField };

export interface OcrExtractionRequest {
  /** contracts.json enums.DocumentType value of the document being extracted. */
  documentType: string;
  /** Original file name of the document version (§6.3.7 trigger tokens). */
  fileName: string;
  /** Hex SHA-256 of the file content (DocumentVersion.sha256). */
  contentSha256: string;
  /** 1-based attempt counter (the `fail` trigger keys on it). */
  attempt: number;
  /** Date anchor for derived dates. */
  referenceDate: Date;
  /** The application's ENTERED data slice (§6.3.7 derived values). */
  entered: OcrEnteredData;
}

export type OcrOutcome =
  | { ok: true; fields: OcrExtractedField[]; rawText: string; latencyMs: number }
  | { ok: false; failure: OcrSimulationFailure; latencyMs: number };

export interface DocumentOcrProvider {
  /** Stored on DocumentJob.provider / OcrExtraction.provider. */
  readonly name: string;
  /** §4.7 provider attribution string shown in the OCR panel (task-035). */
  readonly attribution: string;
  run(request: OcrExtractionRequest): Promise<OcrOutcome>;
}
