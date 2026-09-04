// AUS simulation — PURE CORE (task-024, INT-010/INT-021, RFP §6.3.9).
//
// Rule-based, pure function of its inputs — no clock, no randomness.
//
// §6.3.9 rules:
//   Approve/Eligible  — middle score ≥ 660 AND DTI ≤ 45% AND LTV ≤ 97% AND
//                       no open high fraud flags AND no derogatories in 24 months.
//   Refer with Caution — score < 620 OR DTI > 50% OR a foreclosure/bankruptcy
//                       declaration within 7 years.
//   Refer             — otherwise.
//
// PRECEDENCE (documented interpretation): §6.3.9 does not state which rule wins
// when a file satisfies every Approve/Eligible condition while ALSO carrying a
// Refer-with-Caution trigger (only possible via a foreclosure/bankruptcy
// declaration older than 24 months but within 7 years). The risk-conservative
// reading is implemented: Refer-with-Caution triggers are evaluated FIRST.
//
// The score input is the ASM-003 qualifying score (lower of the borrowers'
// middle scores) — §E: "single function feeding pricing, AUS, qualification
// card, LAR". A missing score/DTI/LTV fails the corresponding Approve
// condition with an itemized "unavailable" reason (it never fabricates a value).

import type { AusCheckResult, CollectionItem } from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AusInput {
  /** ASM-003 qualifying credit score (lower of borrowers' middle scores). */
  middleScore: number | null;
  /** DTI percent (§4.2.7 shared definition). */
  dti: number | null;
  /** LTV percent (§E shared definition, AVM-aware). */
  ltv: number | null;
  /** Count of OPEN HIGH-severity fraud flags on the application. */
  openHighFraudFlagCount: number;
  /** Any derogatory (collection/charge-off/late) within the last 24 months. */
  derogatoryWithin24Months: boolean;
  /** Declarations: foreclosure or bankruptcy within 7 years (§4.2 declarations). */
  foreclosureOrBankruptcyWithin7Years: boolean;
}

// ---------------------------------------------------------------------------
// Derogatory helper (bridges the credit simulation's collections to §6.3.9)
// ---------------------------------------------------------------------------

const DAYS_24_MONTHS = 730;

/** True when any collection/charge-off item is dated within 24 months. */
export function hasDerogatoryWithin24Months(
  collections: readonly CollectionItem[] | null | undefined,
  referenceDate: Date,
): boolean {
  if (!collections) return false;
  const windowStart = referenceDate.getTime() - DAYS_24_MONTHS * 86_400_000;
  return collections.some((c) => {
    if (!c.date) return false;
    const when = Date.parse(c.date);
    return !Number.isNaN(when) && when >= windowStart;
  });
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** §6.3.9 rule evaluation with itemized reasons. */
export function simulateAus(input: AusInput): AusCheckResult {
  const { middleScore, dti, ltv } = input;
  const usedFields = {
    dtiUsed: dti ?? undefined,
    ltvUsed: ltv ?? undefined,
    middleScoreUsed: middleScore ?? undefined,
  };

  // --- Refer with Caution triggers (evaluated first — see header) ----------
  const cautionReasons: string[] = [];
  if (middleScore !== null && middleScore < 620) {
    cautionReasons.push(`Credit score ${middleScore} below 620`);
  }
  if (dti !== null && dti > 50) {
    cautionReasons.push(`DTI ${dti}% above 50%`);
  }
  if (input.foreclosureOrBankruptcyWithin7Years) {
    cautionReasons.push("Foreclosure or bankruptcy declaration within 7 years");
  }
  if (cautionReasons.length > 0) {
    return { recommendation: "refer-with-caution", reasons: cautionReasons, ...usedFields };
  }

  // --- Approve/Eligible conditions (all must hold) -------------------------
  const failures: string[] = [];
  const satisfied: string[] = [];

  if (middleScore === null) failures.push("Credit score unavailable (credit check required)");
  else if (middleScore < 660) failures.push(`Credit score ${middleScore} below 660`);
  else satisfied.push(`Credit score ${middleScore} meets minimum 660`);

  if (dti === null) failures.push("DTI unavailable");
  else if (dti > 45) failures.push(`DTI ${dti}% above 45%`);
  else satisfied.push(`DTI ${dti}% within 45% limit`);

  if (ltv === null) failures.push("LTV unavailable");
  else if (ltv > 97) failures.push(`LTV ${ltv}% above 97%`);
  else satisfied.push(`LTV ${ltv}% within 97% limit`);

  if (input.openHighFraudFlagCount > 0) {
    failures.push(
      `${input.openHighFraudFlagCount} open high-severity fraud flag${input.openHighFraudFlagCount === 1 ? "" : "s"}`,
    );
  } else {
    satisfied.push("No open high-severity fraud flags");
  }

  if (input.derogatoryWithin24Months) {
    failures.push("Derogatory item within the last 24 months");
  } else {
    satisfied.push("No derogatories in the last 24 months");
  }

  if (failures.length === 0) {
    return { recommendation: "approve-eligible", reasons: satisfied, ...usedFields };
  }
  // --- Refer otherwise -----------------------------------------------------
  return { recommendation: "refer", reasons: failures, ...usedFields };
}
