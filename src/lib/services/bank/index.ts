// Bank-aggregator token-flow provider selection + fail-fast configuration
// validation (CH-025 — INV-051, INV-054, INT-023, REQ-039/INT-006). Mirrors
// the OCR seam (src/lib/services/ocr/index.ts): the token-flow endpoints
// import ONLY getBankAggregatorProvider() / bankProviderMode() — swapping
// implementations touches nothing else.
//
// CONFIGURATION (env — §6.1 provider enablement is deployment configuration):
//   BANK_PROVIDER = "simulation" (default — zero-key operation) | "real"
//   A real provider additionally requires PLAID_CLIENT_ID, PLAID_SECRET, and
//   PLAID_ENV.
//
// SCOPE (INV-054 — token flow is ADDITIVE and mode-shared downstream):
//   - The existing credentials flow (POST /api/applications/:id/bank-links,
//     src/lib/services/bank-aggregator.ts + bank-link.ts) is the SIMULATION
//     flow and is untouched by this seam.
//   - The two token-flow endpoints (link-token, exchange) run behind THIS
//     seam: under simulation they return the contracted 503 not-available;
//     under real with the adapter not yet wired they return a retryable 503,
//     never a crash.
//   - A successful exchange (Layer B) converges on the SAME BankLinkSession
//     shape as the credentials flow, so import/unlink stay single-pathed.
//
// REAL-PROVIDER SLOT (Layer B): the aggregator adapter body (link-token
// creation, public-token exchange, revocation at unlink via
// BankLink.externalItemId) is NOT part of this delivery — the
// interface-conformant slot below fail-softs retryable until it is
// hand-completed behind this ratified interface. No SDK dependency and no
// network call exists in this layer.
//
// CREDENTIAL POSTURE (unchanged): plaintext access tokens are never
// serialized into any response and never logged; token-at-rest stays in
// BankLink.accessTokenCiphertext/accessTokenKeyId (the task-002 envelope).

import {
  parseProviderSelection,
  requireProviderKeys,
  type ProviderEnv,
  type ProviderSelection,
} from "@/lib/services/provider-config";
import type { DerivedAccount } from "@/lib/pure/bank-simulation";
import { plaidCreateLinkToken, plaidExchangePublicToken } from "@/lib/services/bank/plaid";

/** Required configuration for BANK_PROVIDER=real (INV-051 — names only). */
const BANK_REQUIRED_KEYS = ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"] as const;

/**
 * §6.1 fail-fast validation (INV-051). Throws ProviderConfigError at module
 * load when the real provider is enabled without its required configuration.
 * Simulation (the default) requires no configuration at all.
 */
export function validateBankProviderConfig(env: ProviderEnv = process.env): void {
  if (parseProviderSelection(env, "BANK_PROVIDER") !== "real") return;
  requireProviderKeys(env, "BANK_PROVIDER", BANK_REQUIRED_KEYS);
}

// Fail fast at startup: the first import of this module (the token-flow
// routes) is the boot path for the bank token-flow seam.
validateBankProviderConfig();

/** The mode flag (INV-054): consumed by the token-flow service and exposed —
 *  as a bare mode word, never key material — to the borrower bank-link UI. */
export function bankProviderMode(env: ProviderEnv = process.env): ProviderSelection {
  return parseProviderSelection(env, "BANK_PROVIDER");
}

// ---------------------------------------------------------------------------
// Token-flow outcomes (the provider interface's fail-soft contract)
// ---------------------------------------------------------------------------

/** Fail-soft outcome — maps to the endpoint's contracted 503, never a crash. */
export interface BankTokenFlowFailure {
  ok: false;
  /** Build-convention machine code: `not_available` (simulation — the token
   *  flow does not exist in this mode) or `provider_unavailable` (real mode,
   *  adapter not reachable/not wired — retry later). */
  code: "not_available" | "provider_unavailable";
  message: string;
  retryable: boolean;
}

/** contracts §A BankLinkTokenResponse payload (exact field names). */
export interface LinkTokenSuccess {
  ok: true;
  linkToken: string;
  /** ISO timestamp string, consistent with existing time fields. */
  expiration: string;
}

/** A successful public-token exchange (Layer B): everything bank-link.ts needs
 *  to persist the link and serialize the SAME BankLinkSession shape as the
 *  credentials flow (INV-054). */
export interface TokenExchangeSuccess {
  ok: true;
  /** The aggregator's item id — persisted to BankLink.externalItemId; required
   *  for token revocation at unlink (INV-054). */
  itemId: string;
  /** The aggregator's institution id — persisted to
   *  BankLink.institutionExternalId (nullable). */
  institutionExternalId: string | null;
  /** Display name for BankLink.institution / the session rows. */
  institutionName: string;
  accounts: DerivedAccount[];
  incomeEvidence: {
    employerName: string;
    employerMatch: boolean;
    averageMonthlyDeposit: number;
  } | null;
  /** The aggregator access token — sealed into the encrypted session envelope,
   *  NEVER serialized into a response or logged. */
  accessToken: string;
}

export type LinkTokenOutcome = LinkTokenSuccess | BankTokenFlowFailure;
export type TokenExchangeOutcome = TokenExchangeSuccess | BankTokenFlowFailure;

export interface TokenExchangeInput {
  /** VR-137: validated non-empty BEFORE this seam is ever called. */
  publicToken: string;
  institutionId: string | null;
  institutionName: string | null;
  applicationId: string;
}

/**
 * The ratified token-flow seam surface (CH-025 Layer A). Revocation at unlink
 * is a Layer-B lifecycle concern — its persisted prerequisite
 * (BankLink.externalItemId) is carried by INV-054 and the exchange outcome.
 */
export interface BankAggregatorProvider {
  name: string;
  createLinkToken(applicationId: string): Promise<LinkTokenOutcome>;
  exchangePublicToken(input: TokenExchangeInput): Promise<TokenExchangeOutcome>;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const SIMULATION_NOT_AVAILABLE: BankTokenFlowFailure = {
  ok: false,
  code: "not_available",
  message:
    "The token-based bank-link flow is not available in simulation mode — use the " +
    "institution picker and credentials flow instead.",
  retryable: false,
};

/** Simulation mode has no token flow (INV-054): the contracted 503 not-available. */
export const simulatedBankAggregatorProvider: BankAggregatorProvider = {
  name: "simulated-bank-aggregator",
  async createLinkToken(): Promise<LinkTokenOutcome> {
    return SIMULATION_NOT_AVAILABLE;
  },
  async exchangePublicToken(): Promise<TokenExchangeOutcome> {
    return SIMULATION_NOT_AVAILABLE;
  },
};

/**
 * Layer-B adapter (Plaid link-token/exchange — bank/plaid.ts). Keyless
 * environments (the deterministic suites) never reach the network: the
 * adapter's key-presence guard returns the retryable 503 outcome immediately
 * (INV-054) — never a crash, never an external call without credentials.
 */
export const realBankAggregatorProvider: BankAggregatorProvider = {
  name: "real-bank-aggregator",
  createLinkToken(applicationId: string): Promise<LinkTokenOutcome> {
    return plaidCreateLinkToken(applicationId);
  },
  exchangePublicToken(input: TokenExchangeInput): Promise<TokenExchangeOutcome> {
    return plaidExchangePublicToken(input);
  },
};

export function getBankAggregatorProvider(): BankAggregatorProvider {
  return bankProviderMode(process.env) === "real"
    ? realBankAggregatorProvider
    : simulatedBankAggregatorProvider;
}
