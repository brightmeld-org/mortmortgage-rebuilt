// Financial-data-aggregator SIMULATION (task-014 — REQ-039, INT-006, INT-017,
// RFP §4.2.10 + §6.3.5). This module is the provider seam: the simulation IS
// the deliverable — a real provider would implement the same surface behind it
// (out of scope by the task's scope-discipline rule).
//
// Surfaces:
//   listInstitutions()          — the ≥6 fictional institutions (stable ids).
//   exchangeCredentials(...)    — the simulated link/auth + account derivation.
//
// SIMULATED LATENCY (§6.3.5 "2,000 ms ± 800 on exchange"):
//   Non-blocking async sleep, applied by the CALLER-FACING exchange BEFORE any
//   DB transaction is opened (never inside one). Jitter is DETERMINISTIC from
//   the username hash (not Math.random) so evidence runs are reproducible.
//   Configurable per the task-015 SIM convention:
//     SIM_LATENCY_BANKLINK_BASE_MS        (default 2000)
//     SIM_LATENCY_BANKLINK_JITTER_MS      (default 800)
//     SIM_LATENCY_BANKLINK_SLOW_EXTRA_MS  (default 8000 — the `slow` password)
//
// FAULT SCENARIOS (SIM_FAULT_<INTEGRATION> convention, task-015):
//   SIM_FAULT_BANKLINK=none  → normal behavior (default; unknown values → none)
//   SIM_FAULT_BANKLINK=slow  → the slow-extra delay applies to EVERY exchange
//   Input triggers (always active, §6.3.5): password exactly `fail` → simulated
//   institution authentication failure; password exactly `slow` → the extra
//   8 s delay, then success.
//
// CREDENTIAL POSTURE: username and password are NEVER persisted, logged, or
// audited. The caller receives derived data only (plus a hash of the username
// for its encrypted session payload).

import { createHash, randomBytes } from "node:crypto";
import {
  deriveAccounts,
  deriveIncomeEvidence,
  deterministicLatencyMs,
  type DerivedAccount,
  type DerivedIncomeEvidence,
} from "@/lib/pure/bank-simulation";

// ---------------------------------------------------------------------------
// Institutions (INT-017): static fictional set, stable UUID-format ids
// ---------------------------------------------------------------------------

/** contracts §A InstitutionInfo — exact field names. */
export interface InstitutionInfo {
  id: string;
  name: string;
}

/**
 * The fictional institution roster (§6.3.5 "at least 6"). Ids are deterministic
 * constants — stable across calls, restarts, and deployments (clients may cache
 * them). Names are invented for this simulation; no real bank is referenced.
 */
export const SIMULATED_INSTITUTIONS: readonly InstitutionInfo[] = [
  { id: "1f0a6e42-93b1-4a77-8c25-0d2f5a1b9c01", name: "First Meridian Bank" },
  { id: "2b8d1c73-5e0f-4d29-9a64-1e3a7b2c8d02", name: "Cascade Union Bank" },
  { id: "3c9e2d84-6f10-4e3a-ab75-2f4b8c3d9e03", name: "Harborline Credit Union" },
  { id: "4d0f3e95-7021-4f4b-bc86-305c9d4eaf04", name: "Silver Birch Savings" },
  { id: "5e104fa6-8132-405c-cd97-416dae5fb005", name: "Granite Peak National Bank" },
  { id: "6f2150b7-9243-416d-dea8-527ebf60c106", name: "Bluewater Federal Credit Union" },
  { id: "702261c8-a354-427e-efb9-638fc071d207", name: "Prairie Rose Bank & Trust" },
  { id: "813372d9-b465-438f-f0ca-7490d182e308", name: "Copperfield Community Bank" },
];

export function listInstitutions(): readonly InstitutionInfo[] {
  return SIMULATED_INSTITUTIONS;
}

export function findInstitution(institutionId: string): InstitutionInfo | undefined {
  return SIMULATED_INSTITUTIONS.find((i) => i.id === institutionId);
}

// ---------------------------------------------------------------------------
// Latency + fault configuration (task-015 SIM convention)
// ---------------------------------------------------------------------------

export type BankLinkSimFault = "none" | "slow";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read SIM_FAULT_BANKLINK at call time (unknown values degrade to "none"). */
export function bankLinkSimFault(): BankLinkSimFault {
  const raw = (process.env.SIM_FAULT_BANKLINK ?? "none").trim().toLowerCase();
  return raw === "slow" ? raw : "none";
}

/**
 * Deterministic exchange latency for a username: base ± jitter (defaults
 * 2000 ± 800 → 1200..2800 ms per §6.3.5), plus the slow-extra delay when the
 * password trigger or SIM_FAULT_BANKLINK=slow asks for it.
 */
export function bankLinkExchangeLatencyMs(username: string, slow: boolean): number {
  const base = envInt("SIM_LATENCY_BANKLINK_BASE_MS", 2000);
  const jitter = envInt("SIM_LATENCY_BANKLINK_JITTER_MS", 800);
  const extra = slow ? envInt("SIM_LATENCY_BANKLINK_SLOW_EXTRA_MS", 8000) : 0;
  return deterministicLatencyMs(`banklink|${username}`, base, jitter) + extra;
}

/** Non-blocking async sleep — never a busy wait, never inside a DB transaction. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Credential exchange (the simulation core)
// ---------------------------------------------------------------------------

export interface ExchangeSuccess {
  ok: true;
  institution: InstitutionInfo;
  accounts: DerivedAccount[];
  incomeEvidence: DerivedIncomeEvidence | null;
  /** SHA-256 of the username — stored (inside the encrypted session payload) in
   *  place of the credential itself; the plaintext username is never persisted. */
  usernameHash: string;
  /** Random opaque access token the "provider" issued (encrypted at rest). */
  accessToken: string;
}

export interface ExchangeAuthFailure {
  ok: false;
}

export type ExchangeResult = ExchangeSuccess | ExchangeAuthFailure;

/**
 * Simulate the aggregator credential exchange (§6.3.5). The caller has already
 * validated non-emptiness (VR-104..106) and resolved the institution.
 *
 * Trigger semantics (exact-match, always active):
 *   password === "fail" → authentication failure ({ ok: false })
 *   password === "slow" → success, but the caller's latency includes +8 s
 *   anything else       → success
 *
 * The returned latency is NOT applied here — the route/service applies it with
 * `sleep()` BEFORE opening any transaction, keeping DB work latency-free.
 */
export function exchangeCredentials(
  institution: InstitutionInfo,
  username: string,
  password: string,
  statedBaseMonthlyIncome: number | null,
  step3EmployerName: string | null,
  referenceDate: Date,
): ExchangeResult {
  if (password === "fail") return { ok: false };

  const accounts = deriveAccounts(username);
  const incomeEvidence = deriveIncomeEvidence(
    username,
    statedBaseMonthlyIncome,
    step3EmployerName,
    referenceDate,
  );
  const usernameHash = createHash("sha256").update(username, "utf8").digest("hex");
  // Random opaque token — the simulated provider credential (encrypted at rest
  // by the caller; regenerating per link is correct: tokens are per-session).
  const accessToken = `sim-tok-${randomBytes(32).toString("base64url")}`;

  return { ok: true, institution, accounts, incomeEvidence, usernameHash, accessToken };
}

/** Does this exchange carry the `slow` trigger (password or SIM fault)? */
export function isSlowExchange(password: string): boolean {
  return password === "slow" || bankLinkSimFault() === "slow";
}
