// Underwriting-check provider interfaces (task-024 — INT-001..005, INT-010).
//
// §6.1: every integration sits behind a provider interface with two
// implementations — the built-in deterministic SIMULATION (default; genuinely
// called in the production code path) and an optional real-provider slot
// enabled by configuration (index.ts). The task-025 orchestration layer
// consumes ONLY these interfaces.
//
// LATENCY CONTRACT (matches the bank-aggregator convention): providers never
// sleep. Every outcome carries `latencyMs` — computed deterministically from
// the input by the simulation — and the CALLER applies it with a non-blocking
// sleep OUTSIDE any database transaction.

import type { CreditBorrowerInput } from "@/lib/pure/simulations/credit";
import type { IncomeEmploymentInput } from "@/lib/pure/simulations/income";
import type { AvmSubjectInput } from "@/lib/pure/simulations/avm";
import type { PricingInput } from "@/lib/pure/simulations/pricing";
import type { AusInput } from "@/lib/pure/simulations/aus";
import type {
  AusCheckResult,
  AvmCheckResult,
  CreditCheckResult,
  IncomeCheckResult,
  PricingCheckResult,
} from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// Shared outcome shape
// ---------------------------------------------------------------------------

/** Failure codes the §6.3 fault scenarios map to (all "error state with Retry"). */
export type CheckFailureCode = "unavailable" | "timeout" | "invalid-response";

export interface CheckFailure {
  code: CheckFailureCode;
  /** Human-readable error the panel displays next to Retry (§4.6.5). */
  message: string;
  /** Every §6.3 failure is retryable (fallback column: "error state with Retry"). */
  retryable: boolean;
  /** 503 for "service unavailable" shapes (§6.3.1 digit-9 first attempt). */
  httpStatus?: number;
}

export type CheckOutcome<T> =
  | { ok: true; result: T; latencyMs: number }
  | { ok: false; failure: CheckFailure; latencyMs: number };

// ---------------------------------------------------------------------------
// Per-check request shapes
// ---------------------------------------------------------------------------

export interface CreditCheckRequest {
  primary: CreditBorrowerInput;
  /** Evaluated SEPARATELY (§6.3.1); feeds the ASM-003 qualifying score. */
  coBorrower?: CreditBorrowerInput | null;
  /** 1-based attempt counter — §6.3.1 digit 9 fails with 503 on attempt 1. */
  attempt: number;
  referenceDate: Date;
}

export interface IncomeCheckRequest {
  employments: readonly IncomeEmploymentInput[];
  referenceDate: Date;
}

export interface AvmCheckRequest {
  subject: AvmSubjectInput;
  referenceDate: Date;
}

export interface PricingCheckRequest {
  pricing: PricingInput;
}

export interface AusCheckRequest {
  aus: AusInput;
}

// ---------------------------------------------------------------------------
// Provider interfaces (one per integration — §6.2 rows 1–4 and 9)
// ---------------------------------------------------------------------------

export interface CreditCheckProvider {
  readonly name: string;
  run(request: CreditCheckRequest): Promise<CheckOutcome<CreditCheckResult>>;
}

export interface IncomeCheckProvider {
  readonly name: string;
  run(request: IncomeCheckRequest): Promise<CheckOutcome<IncomeCheckResult>>;
}

export interface AvmCheckProvider {
  readonly name: string;
  run(request: AvmCheckRequest): Promise<CheckOutcome<AvmCheckResult>>;
}

export interface PricingCheckProvider {
  readonly name: string;
  run(request: PricingCheckRequest): Promise<CheckOutcome<PricingCheckResult>>;
}

export interface AusCheckProvider {
  readonly name: string;
  run(request: AusCheckRequest): Promise<CheckOutcome<AusCheckResult>>;
}
