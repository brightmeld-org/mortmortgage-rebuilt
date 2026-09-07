// Plaid adapter for the BankAggregatorProvider seam (CH-025 Layer B —
// INT-023, INV-051/053/054). Hand-completed behind the ratified interface:
// link-token creation, public-token exchange (accounts + institution), and
// best-effort item revocation for unlink. No SDK dependency — server-side
// fetch against the Plaid REST API for the environment PLAID_ENV selects
// (sandbox|development|production; fail-fast validated at module load by
// bank/index.ts).
//
// CREDENTIAL POSTURE (INV-054, unchanged): PLAID_CLIENT_ID/PLAID_SECRET are
// read from env per request and appear only in server-side request bodies;
// the access token returned by the exchange is handed to bank-link.ts, which
// seals it into the encrypted session envelope — never serialized to a
// client, never logged.

import { createHash } from "node:crypto";
import type {
  LinkTokenOutcome,
  TokenExchangeInput,
  TokenExchangeOutcome,
} from "@/lib/services/bank/index";
import type { DerivedAccount, SimulatedAccountType } from "@/lib/pure/bank-simulation";

const TIMEOUT_MS = 15_000;

function plaidBaseUrl(): string {
  const env = (process.env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  const host = env === "production" ? "production" : env === "development" ? "development" : "sandbox";
  return `https://${host}.plaid.com`;
}

class PlaidApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly errorCode: string | null,
  ) {
    // Message carries codes only — never request/response bodies (token posture).
    super(`Plaid ${endpoint} failed: HTTP ${status}${errorCode ? ` ${errorCode}` : ""}`);
  }
}

async function plaidPost(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${plaidBaseUrl()}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        ...body,
      }),
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PlaidApiError(
        endpoint,
        res.status,
        typeof payload.error_code === "string" ? payload.error_code : null,
      );
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(message: string): { ok: false; code: "provider_unavailable"; message: string; retryable: true } {
  return { ok: false, code: "provider_unavailable", message, retryable: true };
}

/**
 * Keyless guard: the deterministic suites (and any keyless boot) must never
 * cause a network call — with the credentials absent the adapter returns the
 * same retryable outcome the unwired slot had, immediately. Fail-fast config
 * validation (INV-051) prevents a real-mode SERVER from ever reaching here
 * keyless; this guard is what keeps `npm test` offline.
 */
function plaidKeysPresent(): boolean {
  return Boolean(
    process.env.PLAID_CLIENT_ID?.trim() &&
      process.env.PLAID_SECRET?.trim() &&
      process.env.PLAID_ENV?.trim(),
  );
}

const KEYLESS = unavailable(
  "The bank aggregation provider is not configured in this environment — set PLAID_CLIENT_ID, " +
    "PLAID_SECRET, and PLAID_ENV, or remove BANK_PROVIDER to use the built-in simulation.",
);

// ---------------------------------------------------------------------------
// Account mapping
// ---------------------------------------------------------------------------

function mapAccountType(type: unknown, subtype: unknown): SimulatedAccountType {
  const s = typeof subtype === "string" ? subtype : "";
  if (s === "savings") return "savings";
  if (s === "money market") return "money-market";
  if (typeof type === "string" && type === "investment") return "stocks";
  return "checking";
}

/** Clamp a Plaid balance into a finite non-negative dollars value. */
function mapBalance(balances: Record<string, unknown> | undefined): number {
  const current = balances?.current;
  const available = balances?.available;
  const v =
    typeof current === "number" && Number.isFinite(current)
      ? current
      : typeof available === "number" && Number.isFinite(available)
        ? available
        : 0;
  return Math.max(0, Math.round(v * 100) / 100);
}

/**
 * The provider does not expose full account numbers on /accounts/get (that is
 * Plaid's auth product); the internal fullAccountNumber slot — encrypted at
 * import, never displayed — is synthesized deterministically from the stable
 * account_id so imports are reproducible per account.
 */
function syntheticFullAccountNumber(accountId: string): string {
  const digits = createHash("sha256").update(accountId, "utf8").digest("hex").replace(/\D/g, "");
  return (digits + "0000000000").slice(0, 10);
}

interface PlaidAccountRow {
  account_id?: unknown;
  type?: unknown;
  subtype?: unknown;
  mask?: unknown;
  balances?: Record<string, unknown>;
}

function mapAccounts(rows: unknown): DerivedAccount[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is PlaidAccountRow => typeof (r as PlaidAccountRow)?.account_id === "string")
    .map((r) => ({
      externalAccountId: r.account_id as string,
      accountType: mapAccountType(r.type, r.subtype),
      last4:
        typeof r.mask === "string" && /^\d{2,4}$/.test(r.mask)
          ? r.mask.padStart(4, "0")
          : (r.account_id as string).replace(/\D/g, "").padStart(4, "0").slice(-4),
      balance: mapBalance(r.balances),
      fullAccountNumber: syntheticFullAccountNumber(r.account_id as string),
    }));
}

// ---------------------------------------------------------------------------
// Provider operations (wired into realBankAggregatorProvider)
// ---------------------------------------------------------------------------

export async function plaidCreateLinkToken(applicationId: string): Promise<LinkTokenOutcome> {
  if (!plaidKeysPresent()) return KEYLESS;
  try {
    const payload = await plaidPost("/link/token/create", {
      client_name: "MortMortgage",
      user: { client_user_id: applicationId },
      products: ["auth"],
      country_codes: ["US"],
      language: "en",
    });
    const linkToken = payload.link_token;
    const expiration = payload.expiration;
    if (typeof linkToken !== "string" || linkToken === "") {
      return unavailable("The bank aggregation provider returned no link token — retry later.");
    }
    return {
      ok: true,
      linkToken,
      expiration: typeof expiration === "string" ? expiration : new Date(Date.now() + 4 * 3600_000).toISOString(),
    };
  } catch (err) {
    console.error("plaid link-token error:", err instanceof Error ? err.message : "unknown");
    return unavailable(
      "The bank aggregation provider could not issue a link token — retry later, or remove BANK_PROVIDER to use the built-in simulation.",
    );
  }
}

export async function plaidExchangePublicToken(
  input: TokenExchangeInput,
): Promise<TokenExchangeOutcome> {
  if (!plaidKeysPresent()) return KEYLESS;
  try {
    const exchange = await plaidPost("/item/public_token/exchange", {
      public_token: input.publicToken,
    });
    const accessToken = exchange.access_token;
    const itemId = exchange.item_id;
    if (typeof accessToken !== "string" || typeof itemId !== "string") {
      return unavailable("The bank aggregation provider returned an incomplete exchange — retry later.");
    }

    const accountsRes = await plaidPost("/accounts/get", { access_token: accessToken });
    const accounts = mapAccounts(accountsRes.accounts);
    if (accounts.length === 0) {
      return unavailable("The linked item exposed no accounts — retry later or link a different institution.");
    }

    // Institution: prefer the widget's metadata; fall back to a lookup.
    const item = accountsRes.item as { institution_id?: unknown } | undefined;
    const institutionExternalId =
      input.institutionId ?? (typeof item?.institution_id === "string" ? item.institution_id : null);
    let institutionName = input.institutionName ?? "";
    if (!institutionName && institutionExternalId) {
      try {
        const inst = await plaidPost("/institutions/get_by_id", {
          institution_id: institutionExternalId,
          country_codes: ["US"],
        });
        const name = (inst.institution as { name?: unknown } | undefined)?.name;
        if (typeof name === "string") institutionName = name;
      } catch {
        // non-fatal — display name falls back below
      }
    }
    if (!institutionName) institutionName = "Linked institution";

    return {
      ok: true,
      itemId,
      institutionExternalId,
      institutionName,
      accounts,
      // Income evidence requires a Plaid income product this delivery does not
      // enable — null is the honest, contract-legal value (the Step 3 panel
      // simply does not render provider evidence for this link).
      incomeEvidence: null,
      accessToken,
    };
  } catch (err) {
    console.error("plaid exchange error:", err instanceof Error ? err.message : "unknown");
    return unavailable(
      "The bank aggregation provider could not complete the exchange — retry later, or remove BANK_PROVIDER to use the built-in simulation.",
    );
  }
}

/**
 * Best-effort item revocation at unlink (INV-054's reason for persisting
 * externalItemId). Requires the decrypted session access token from the
 * caller (bank-link.ts owns the envelope). Failures are logged and swallowed:
 * the local unlink (token ciphertext removal) must never be blocked by an
 * unreachable aggregator.
 */
export async function plaidRemoveItem(accessToken: string): Promise<void> {
  try {
    await plaidPost("/item/remove", { access_token: accessToken });
  } catch (err) {
    console.error("plaid item-remove error (non-blocking):", err instanceof Error ? err.message : "unknown");
  }
}
