// Underwriting-check orchestration (task-025 — REQ-059, NFR-022, INT-001..005,
// INT-010, INT-013..016, INT-021, INV-030/031, SEC-21, XBR-022, ASYNC-005).
//
// POST /api/applications/:id/checks/:checkType → 202 running UnderwritingResultInfo
// GET  /api/applications/:id/checks            → UnderwritingResultList (max 25)
// GET  /api/applications/:id/qualification     → QualificationSummary
//
// ===========================================================================
// ASYNC-005 CONFORMANCE POSTURE (as implemented — no queue library exists in
// this build; pg-boss / the worker process is task-034/045, increments 8/11,
// the same pattern increments 3/4 used for ASYNC-001/003):
//   - Row-before-response: the POST creates the `running` UnderwritingResult in
//     a transaction and returns 202 with its UnderwritingResultInfo before any
//     provider work happens.
//   - Serial-per-key (idempotency key `uw-check:{applicationId}:{checkType}`):
//     satisfied by the DATABASE, not application code — an ADDITIVE migration
//     adds a partial unique index on (applicationId, checkType) WHERE
//     status = 'running' (INV-031). A concurrent duplicate POST hits P2002 and
//     is "ignored server-side" per §4.6.5: the endpoint is idempotent while in
//     flight, so the second request receives 202 with the EXISTING running row
//     (no new row, no audit, no provider run) — never a check-then-act race:
//     the index decides.
//   - Execution: after the transaction commits, the provider seam
//     (src/lib/services/checks) runs OUTSIDE any transaction; its returned
//     `latencyMs` is applied with a non-blocking sleep (also outside any
//     transaction), then the completion is recorded in a SECOND transaction
//     (multi-tx-with-reconciler). Routes hand the execution promise to Next
//     15's `after()` so the 202 returns first.
//   - Completion recording is the single named seam `recordCheckOutcome()`:
//     result JSON stored VERBATIM in the §A wire shape, summary + riskBadge +
//     completedAt, in-tx audit with a result summary (REQ-059 / §4.6.5), and
//     the marked one-line insertion point for the task-027 fraud engine
//     (XBR-022).
//   - Reconciler: `reconcileStuckUnderwritingChecks()` marks rows stuck in
//     `running` longer than STUCK_RUNNING_THRESHOLD_MS as errored with a
//     retryable message. It is invoked LAZILY (cheap guarded query) at the top
//     of POST check and GET checks, and EXPORTED for boot wiring by
//     task-034/045 (reconciler-on-boot).
//   - Retry policy maxAttempts=1: no automatic retry. Manual Retry = a new
//     POST after an errored (or completed) result; the new run supersedes the
//     prior via supersededById at START time, so exactly one row per
//     (application, checkType) has supersededById = null — "the" current
//     result the T11/T15 gates and the panel read. History is retained.
//     The credit attempt counter (§6.3.1 digit-9: 503 on attempt 1, Good on
//     retry) = count of consecutive most-recent errored credit runs + 1, so
//     every fresh pull after a success starts at attempt 1 again.
// ===========================================================================
//
// SEC-21 / INV-031 state gate: checks may start only in states 3-8
// (completeness_validated, documents_received, aus_executed,
// preliminary_decision, escalated_review, conditional_approval) with an active
// assignment (caseworker) or as a Supervisor — supervisors flow through the
// SAME lock, supersede, gate, and audit paths (admin-endpoint invariant).
//
// INV-030 is respected, not re-derived: corrections (task-023) and the
// workflow engine (T36/revision) mark results stale via the shared
// underwriting-staleness helper; this module only exposes isStale and clears
// Application.ausStale when a fresh AUS run completes ("blocking T15 until
// re-run" — the re-run is what un-blocks it).
//
// LIVE-STATE: every provider input is assembled from the live application rows
// (borrowers, employments, subject property, loan, housing expense, prior
// credit result, shared DTI/LTV module) — nothing hardcoded. SSN is encrypted
// at rest; the §6.3.1 scenario digit comes from the PLAINTEXT ssnLast4 column.

import { Prisma, type CheckType, type UnderwritingResult, type WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import { sleep } from "@/lib/services/bank-aggregator";
import { workflowStateLabel } from "@/lib/pure/workflow";
import {
  getAusCheckProvider,
  getAvmCheckProvider,
  getCreditCheckProvider,
  getIncomeCheckProvider,
  getPricingCheckProvider,
  type CheckOutcome,
} from "@/lib/services/checks";
import type {
  AusCheckResult,
  AvmCheckResult,
  CreditCheckResult,
  IncomeCheckResult,
  PricingCheckResult,
} from "@/lib/pure/simulations/check-results";
import { hasDerogatoryWithin24Months } from "@/lib/pure/simulations/aus";
import type { CreditBorrowerInput } from "@/lib/pure/simulations/credit";
import type { IncomeEmploymentInput } from "@/lib/pure/simulations/income";
import {
  computeApplicationQualification,
  persistApplicationQualification,
} from "@/lib/services/qualification";
import { evaluateEscalation } from "@/lib/services/approval";
import { evaluateFraudTriggersForResult } from "@/lib/services/fraud";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** contracts.json enums.CheckType, verbatim. */
export const CHECK_TYPE_VALUES = ["credit", "income", "avm", "pricing", "aus"] as const;

/** The four checks AUS consumes and the T11 gate requires (INV-030). */
const PRE_AUS_CHECK_TYPES = ["credit", "income", "avm", "pricing"] as const;

/**
 * SEC-21 / INV-031: workflow states 3-8 per the §4.5.1 numbering
 * (3 completeness_validated .. 8 conditional_approval).
 */
export const CHECK_ELIGIBLE_STATES: readonly WorkflowState[] = [
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
];

/**
 * ASYNC-005 states no explicit stuck threshold; the ASYNC-004 analogue (stuck
 * DocumentJobs) uses 10 minutes, so the boot/lazy reconciler uses the same.
 */
export const STUCK_RUNNING_THRESHOLD_MS = 10 * 60_000;

const STUCK_ERROR_MESSAGE =
  "The check did not complete within 10 minutes and was marked failed. Retry the check.";

type CheckResultPayload =
  | CreditCheckResult
  | IncomeCheckResult
  | AvmCheckResult
  | PricingCheckResult
  | AusCheckResult;

// ---------------------------------------------------------------------------
// UnderwritingResultInfo serializer (contracts §A — field names verbatim)
// ---------------------------------------------------------------------------

/** Wire shape per contracts.json models.UnderwritingResultInfo — exact field names. */
export interface UnderwritingResultInfo {
  id: string;
  applicationId: string;
  checkType: CheckType;
  status: "running" | "completed" | "error";
  provider?: string;
  requestedByName?: string;
  requestedAt: string;
  completedAt?: string;
  summary?: string;
  riskBadge?: "green" | "yellow" | "red";
  isStale: boolean;
  supersededById?: string;
  error?: string;
  credit?: CreditCheckResult;
  income?: IncomeCheckResult;
  avm?: AvmCheckResult;
  pricing?: PricingCheckResult;
  aus?: AusCheckResult;
}

export interface UnderwritingResultList {
  rows: UnderwritingResultInfo[];
}

type ResultRowWithRequester = UnderwritingResult & {
  requestedByUser?: { firstName: string; lastName: string } | null;
};

/** Serialize a row to §A UnderwritingResultInfo. The stored result JSON is the verbatim wire payload. */
export function toUnderwritingResultInfo(row: ResultRowWithRequester): UnderwritingResultInfo {
  const info: UnderwritingResultInfo = {
    id: row.id,
    applicationId: row.applicationId,
    checkType: row.checkType,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    isStale: row.isStale,
  };
  if (row.provider !== null) info.provider = row.provider;
  if (row.requestedByUser) {
    const name = `${row.requestedByUser.firstName} ${row.requestedByUser.lastName}`.trim();
    if (name.length > 0) info.requestedByName = name;
  }
  if (row.completedAt !== null) info.completedAt = row.completedAt.toISOString();
  if (row.summary !== null) info.summary = row.summary;
  if (row.riskBadge !== null) info.riskBadge = row.riskBadge;
  if (row.supersededById !== null) info.supersededById = row.supersededById;
  if (row.error !== null) info.error = row.error;
  if (row.result !== null && typeof row.result === "object" && !Array.isArray(row.result)) {
    // Stored verbatim by recordCheckOutcome — surface under the checkType key.
    const payload = row.result as unknown;
    switch (row.checkType) {
      case "credit":
        info.credit = payload as CreditCheckResult;
        break;
      case "income":
        info.income = payload as IncomeCheckResult;
        break;
      case "avm":
        info.avm = payload as AvmCheckResult;
        break;
      case "pricing":
        info.pricing = payload as PricingCheckResult;
        break;
      case "aus":
        info.aus = payload as AusCheckResult;
        break;
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Reconciler (ASYNC-005 crash recovery: reconciler-on-boot + lazy invocation)
// ---------------------------------------------------------------------------

/**
 * Mark UnderwritingResults stuck in `running` longer than the threshold as
 * errored with a retryable message. Idempotent and cheap when nothing is stuck
 * (a single indexed query). Called lazily at the top of POST check / GET
 * checks (scoped to that application) and exported for boot wiring by the
 * task-034/045 worker (unscoped).
 *
 * @returns the number of rows reconciled.
 */
export async function reconcileStuckUnderwritingChecks(applicationId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_RUNNING_THRESHOLD_MS);
  const stuck = await prisma.underwritingResult.findMany({
    where: {
      ...(applicationId ? { applicationId } : {}),
      status: "running",
      requestedAt: { lt: cutoff },
    },
    select: { id: true, applicationId: true, checkType: true },
  });
  if (stuck.length === 0) return 0;

  let reconciled = 0;
  await prisma.$transaction(async (tx) => {
    for (const row of stuck) {
      // Guarded per-row update: a row that completed between the scan and this
      // transaction is left alone (the scan is idempotent — ASYNC-004 posture).
      const updated = await tx.underwritingResult.updateMany({
        where: { id: row.id, status: "running" },
        data: { status: "error", completedAt: new Date(), error: STUCK_ERROR_MESSAGE },
      });
      if (updated.count === 0) continue;
      reconciled += 1;
      await audit(tx as AuditTransactionClient, {
        actor: null,
        role: "SYSTEM",
        actionType: "underwriting-check",
        applicationId: row.applicationId,
        entityType: "UnderwritingResult",
        entityId: row.id,
        summary: `${row.checkType}: marked errored by the stuck-check reconciler (running > 10 minutes) — retry available`,
      });
    }
  });
  return reconciled;
}

// ---------------------------------------------------------------------------
// Live input assembly (LIVE-STATE rule — everything from the DB rows)
// ---------------------------------------------------------------------------

function asObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: Prisma.JsonValue | null | undefined): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Prisma.JsonObject => typeof row === "object" && row !== null && !Array.isArray(row),
  ) as Record<string, unknown>[];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

interface LiveBorrowerRow {
  ordinal: number;
  firstName: string | null;
  lastName: string | null;
  ssnLast4: string | null;
  employments: Prisma.JsonValue | null;
  declarations: Prisma.JsonValue | null;
}

interface LiveCheckContext {
  applicationId: string;
  applicationNumber: string;
  borrowers: LiveBorrowerRow[];
  subjectProperty: Record<string, unknown> | null;
  loan: Record<string, unknown> | null;
  proposedHousingExpense: Record<string, unknown> | null;
}

async function loadLiveContext(applicationId: string): Promise<LiveCheckContext> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, applicationNumber: true },
  });
  if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  const borrowers = await prisma.borrower.findMany({
    where: { applicationId },
    orderBy: { ordinal: "asc" },
    select: {
      ordinal: true,
      firstName: true,
      lastName: true,
      ssnLast4: true,
      employments: true,
      declarations: true,
    },
  });
  const data = await prisma.applicationData.findUnique({
    where: { applicationId },
    select: { subjectProperty: true, loan: true, proposedHousingExpense: true },
  });
  return {
    applicationId,
    applicationNumber: app.applicationNumber,
    borrowers,
    subjectProperty: asObject(data?.subjectProperty ?? null),
    loan: asObject(data?.loan ?? null),
    proposedHousingExpense: asObject(data?.proposedHousingExpense ?? null),
  };
}

function incompleteInputs(checkType: CheckType, missing: string[]): HttpProblem {
  return new HttpProblem(
    409,
    ERROR_CODES.conflict,
    `The ${checkType} check cannot run — required application data is missing: ${missing.join(", ")}`,
  );
}

function creditBorrowerInput(row: LiveBorrowerRow): CreditBorrowerInput | null {
  if (!row.ssnLast4 || !/\d$/.test(row.ssnLast4)) return null;
  return {
    ssnLast4: row.ssnLast4,
    fullName: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Borrower",
    // DOB is encrypted at rest (NFR-002) and is seed-material-only for the
    // §6.3.1 simulation (scenario keys on the SSN last digit) — not decrypted here.
    dateOfBirth: null,
  };
}

/**
 * §6.3.1 attempt derivation (ASYNC-005 maxAttempts=1 — every retry is a manual
 * POST): attempt = count of CONSECUTIVE most-recent errored credit runs + 1,
 * so digit-9 fails with 503 on a fresh pull and succeeds on the manual retry;
 * after a success the next fresh pull starts at attempt 1 again.
 */
async function deriveCreditAttempt(applicationId: string, excludeResultId?: string): Promise<number> {
  const rows = await prisma.underwritingResult.findMany({
    where: {
      applicationId,
      checkType: "credit",
      ...(excludeResultId ? { id: { not: excludeResultId } } : {}),
    },
    orderBy: { requestedAt: "desc" },
    select: { status: true },
    take: 25,
  });
  let consecutiveErrors = 0;
  for (const row of rows) {
    if (row.status === "error") consecutiveErrors += 1;
    else break;
  }
  return consecutiveErrors + 1;
}

function incomeInputs(ctx: LiveCheckContext): IncomeEmploymentInput[] {
  const inputs: IncomeEmploymentInput[] = [];
  for (const borrower of ctx.borrowers) {
    for (const employment of asArray(borrower.employments)) {
      const employerName = stringOrNull(employment.employerName);
      if (!employerName) continue;
      inputs.push({
        employerName,
        statedBaseMonthlyIncome: numberOrNull(employment.baseMonthlyIncome),
        startDate: stringOrNull(employment.startDate),
      });
    }
  }
  return inputs;
}

function subjectAddressText(address: Record<string, unknown> | null): string | null {
  if (!address) return null;
  const parts = [
    stringOrNull(address.street),
    stringOrNull(address.unit),
    stringOrNull(address.city),
    [stringOrNull(address.state), stringOrNull(address.zip)].filter(Boolean).join(" ") || null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Latest completed, non-superseded result of a type (the gates' "current" row). */
async function currentResult(applicationId: string, checkType: CheckType) {
  return prisma.underwritingResult.findFirst({
    where: { applicationId, checkType, supersededById: null },
    orderBy: { requestedAt: "desc" },
  });
}

function currentCreditPayload(row: UnderwritingResult | null): CreditCheckResult | null {
  if (!row || row.status !== "completed") return null;
  const payload = asObject(row.result);
  return payload ? (payload as unknown as CreditCheckResult) : null;
}

// ---------------------------------------------------------------------------
// Provider dispatch — assembles the live request and returns the executor
// ---------------------------------------------------------------------------

interface PreparedProviderCall {
  providerName: string;
  execute: () => Promise<CheckOutcome<CheckResultPayload>>;
}

async function prepareProviderCall(
  checkType: CheckType,
  ctx: LiveCheckContext,
): Promise<PreparedProviderCall> {
  const referenceDate = new Date();

  switch (checkType) {
    case "credit": {
      const primaryRow = ctx.borrowers.find((b) => b.ordinal === 1) ?? null;
      const primary = primaryRow ? creditBorrowerInput(primaryRow) : null;
      if (!primary) throw incompleteInputs("credit", ["primary borrower SSN"]);
      const coRow = ctx.borrowers.find((b) => b.ordinal === 2) ?? null;
      const coBorrower = coRow ? creditBorrowerInput(coRow) : null;
      if (coRow && !coBorrower) throw incompleteInputs("credit", ["co-borrower SSN"]);
      const attempt = await deriveCreditAttempt(ctx.applicationId);
      const provider = getCreditCheckProvider();
      return {
        providerName: provider.name,
        execute: () => provider.run({ primary, coBorrower, attempt, referenceDate }),
      };
    }
    case "income": {
      const employments = incomeInputs(ctx);
      if (employments.length === 0) throw incompleteInputs("income", ["at least one employment record"]);
      const provider = getIncomeCheckProvider();
      return {
        providerName: provider.name,
        execute: () => provider.run({ employments, referenceDate }),
      };
    }
    case "avm": {
      const address = asObject(ctx.subjectProperty?.address ?? null);
      const geocode = asObject(ctx.subjectProperty?.geocode ?? null);
      const addressText = subjectAddressText(address);
      const zip = stringOrNull(address?.zip);
      const statedValue = numberOrNull(ctx.subjectProperty?.estimatedValue);
      const missing: string[] = [];
      if (!addressText) missing.push("subject property address");
      if (!zip) missing.push("subject property ZIP");
      if (statedValue === null) missing.push("stated (estimated) property value");
      if (missing.length > 0) throw incompleteInputs("avm", missing);
      const provider = getAvmCheckProvider();
      return {
        providerName: provider.name,
        execute: () =>
          provider.run({
            subject: {
              addressText: addressText!,
              zip: zip!,
              statedValue: statedValue!,
              propertyType: stringOrNull(ctx.subjectProperty?.propertyType),
              latitude: numberOrNull(geocode?.latitude),
              longitude: numberOrNull(geocode?.longitude),
              requestedLoanAmount: numberOrNull(ctx.loan?.requestedLoanAmount),
            },
            referenceDate,
          }),
      };
    }
    case "pricing": {
      const loanType = stringOrNull(ctx.loan?.loanType);
      const loanTermMonths = numberOrNull(ctx.loan?.loanTermMonths);
      const requestedLoanAmount = numberOrNull(ctx.loan?.requestedLoanAmount);
      const missing: string[] = [];
      if (!loanType) missing.push("loan type");
      if (loanTermMonths === null) missing.push("loan term");
      if (requestedLoanAmount === null) missing.push("requested loan amount");
      if (missing.length > 0) throw incompleteInputs("pricing", missing);

      // Live qualifying score (ASM-003) from the current credit result, when one exists.
      const credit = currentCreditPayload(await currentResult(ctx.applicationId, "credit"));
      const qualification = await computeApplicationQualification(ctx.applicationId);
      const refinance = asObject(ctx.loan?.refinance ?? null);
      const cashOut =
        ctx.loan?.loanPurpose === "refinance-cash-out" || refinance?.purposeOfRefinance === "cash-out";

      const provider = getPricingCheckProvider();
      return {
        providerName: provider.name,
        execute: () =>
          provider.run({
            pricing: {
              loanType: loanType!,
              amortizationType: stringOrNull(ctx.loan?.amortizationType),
              loanTermMonths: loanTermMonths!,
              requestedLoanAmount: requestedLoanAmount!,
              qualifyingCreditScore: credit?.qualifyingScore ?? credit?.middleScore ?? null,
              ltv: qualification.ltv,
              occupancy: stringOrNull(ctx.subjectProperty?.occupancy),
              propertyType: stringOrNull(ctx.subjectProperty?.propertyType),
              numberOfUnits: numberOrNull(ctx.subjectProperty?.numberOfUnits),
              cashOut,
              monthlyPropertyTaxes: numberOrNull(ctx.proposedHousingExpense?.propertyTaxes),
              monthlyInsurance: numberOrNull(ctx.proposedHousingExpense?.homeownersInsurance),
            },
          }),
      };
    }
    case "aus": {
      // §4.6.5 "Runs after the four checks": every pre-AUS check must be
      // completed, non-errored, and non-stale (INV-030 wording) — else 409.
      const notReady: string[] = [];
      let creditPayload: CreditCheckResult | null = null;
      for (const type of PRE_AUS_CHECK_TYPES) {
        const row = await currentResult(ctx.applicationId, type);
        if (!row || row.status !== "completed" || row.error || row.isStale) {
          notReady.push(type);
        } else if (type === "credit") {
          creditPayload = currentCreditPayload(row);
        }
      }
      if (notReady.length > 0) {
        throw new HttpProblem(
          409,
          ERROR_CODES.conflict,
          `AUS runs after the four checks — these are not completed, error-free, and current: ${notReady.join(", ")}`,
        );
      }

      const qualification = await computeApplicationQualification(ctx.applicationId);
      const openHighFraudFlagCount = await prisma.fraudFlag.count({
        where: { applicationId: ctx.applicationId, status: "open", severity: "high" },
      });
      // §6.3.9 declaration input: foreclosure (L) or bankruptcy (M) on any borrower.
      const foreclosureOrBankruptcy = ctx.borrowers.some((b) => {
        const declarations = asObject(b.declarations);
        return declarations?.lForeclosed === true || declarations?.mBankruptcy === true;
      });

      const provider = getAusCheckProvider();
      return {
        providerName: provider.name,
        execute: () =>
          provider.run({
            aus: {
              middleScore: creditPayload?.qualifyingScore ?? creditPayload?.middleScore ?? null,
              dti: qualification.dti,
              ltv: qualification.ltv,
              openHighFraudFlagCount,
              derogatoryWithin24Months: hasDerogatoryWithin24Months(
                creditPayload?.collections,
                referenceDate,
              ),
              foreclosureOrBankruptcyWithin7Years: foreclosureOrBankruptcy,
            },
          }),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Summary + risk badge (§4.6.5 displayed thresholds)
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<string, string> = { good: "Good", fair: "Fair", poor: "Poor" };

function summarize(
  checkType: CheckType,
  payload: CheckResultPayload,
): { summary: string; riskBadge: "green" | "yellow" | "red" | null } {
  switch (checkType) {
    case "credit": {
      const credit = payload as CreditCheckResult;
      const score = credit.qualifyingScore ?? credit.middleScore;
      const tier = credit.riskTier ? TIER_LABELS[credit.riskTier] ?? credit.riskTier : null;
      // §4.6.5 credit badge = risk tier (Good ≥700 / Fair 640-699 / Poor <640).
      const badge =
        credit.riskTier === "good" ? "green" : credit.riskTier === "fair" ? "yellow" : credit.riskTier === "poor" ? "red" : null;
      return {
        summary: `credit: score ${score ?? "unavailable"}${tier ? `, tier ${tier}` : ""}`,
        riskBadge: badge,
      };
    }
    case "income": {
      const income = payload as IncomeCheckResult;
      const rows = income.employments;
      const verified = rows.filter((r) => r.employerVerified).length;
      const maxVariance = rows.reduce(
        (max, r) => (typeof r.variancePct === "number" && r.variancePct > max ? r.variancePct : max),
        0,
      );
      // §4.6.5: green ≤5% variance, yellow ≤10%, red >10% or unverified.
      const anyUnverified = rows.some((r) => !r.employerVerified);
      const badge = anyUnverified || maxVariance > 10 ? "red" : maxVariance > 5 ? "yellow" : "green";
      return {
        summary: `income: ${verified}/${rows.length} employers verified, max variance ${maxVariance.toFixed(1)}%`,
        riskBadge: badge,
      };
    }
    case "avm": {
      const avm = payload as AvmCheckResult;
      // §4.6.5: badge by LTV using AVM value — green ≤80, yellow ≤95, red >95.
      const ltv = typeof avm.recomputedLtv === "number" ? avm.recomputedLtv : null;
      const badge = ltv === null ? null : ltv <= 80 ? "green" : ltv <= 95 ? "yellow" : "red";
      return {
        summary: `avm: value $${Math.round(avm.estimatedValue).toLocaleString("en-US")}${
          ltv === null ? "" : `, AVM LTV ${ltv.toFixed(1)}%`
        }`,
        riskBadge: badge,
      };
    }
    case "pricing": {
      const pricing = payload as PricingCheckResult;
      const par = pricing.scenarios.find((s) => s.name === "par") ?? pricing.scenarios[0];
      const base = typeof pricing.baseRate === "number" ? pricing.baseRate : null;
      // §4.6.5: badge by par rate vs base — green ≤ +0.25, yellow ≤ +0.75, red > +0.75.
      const delta = par && base !== null ? par.interestRate - base : null;
      const badge = delta === null ? null : delta <= 0.25 ? "green" : delta <= 0.75 ? "yellow" : "red";
      return {
        summary: `pricing: par ${par ? `${par.interestRate.toFixed(3)}%` : "unavailable"}${
          base !== null ? ` (base ${base.toFixed(3)}%)` : ""
        }`,
        riskBadge: badge,
      };
    }
    case "aus": {
      const aus = payload as AusCheckResult;
      // Badge mapping for AUS is not fixed by §4.6.5; documented convention:
      // approve-eligible → green, refer → yellow, refer-with-caution → red.
      const badge =
        aus.recommendation === "approve-eligible"
          ? "green"
          : aus.recommendation === "refer"
            ? "yellow"
            : "red";
      return {
        summary: `aus: ${aus.recommendation}, ${aus.reasons.length} reason(s)`,
        riskBadge: badge,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// recordCheckOutcome — THE single completion-recording seam (ASYNC-005)
// ---------------------------------------------------------------------------

/**
 * §4.8.2 caseworker trigger "underwriting check or AUS result recorded":
 * in-tx notification to the current active assignee via THE notification
 * service (task-036, §4.8.1). No-op when unassigned.
 */
async function notifyAssignedCaseworkerOfResult(
  tx: Prisma.TransactionClient,
  applicationId: string,
  checkType: CheckType,
  summary: string,
): Promise<void> {
  const assignment = await tx.caseworkerAssignment.findFirst({
    where: { applicationId, endedAt: null },
    select: { caseworkerUserId: true },
  });
  if (!assignment) return;
  await createNotification(tx, {
    recipientUserId: assignment.caseworkerUserId,
    type: "underwriting-result",
    title: `${checkType === "aus" ? "AUS" : checkType.charAt(0).toUpperCase() + checkType.slice(1)} result recorded`,
    body: summary,
    applicationId,
  });
}

export interface RecordCheckOutcomeInput {
  resultId: string;
  applicationId: string;
  checkType: CheckType;
  outcome: CheckOutcome<CheckResultPayload>;
  /** Requesting user's identity FROM THE SESSION at POST time (audit integrity). */
  actor: { userId: string; role: "CASEWORKER" | "SUPERVISOR" };
  meta: RequestMetaBundle;
}

/**
 * Record a check's completion or error in ONE transaction: result JSON stored
 * verbatim (§A wire shape), summary + riskBadge + completedAt, in-tx audit
 * with the result summary (REQ-059 §4.6.5, e.g. "credit: score 742, tier
 * Good"). A fresh completed AUS run clears Application.ausStale (the "until
 * re-run" of INV-030). Guarded: only a row still in `running` is written — a
 * row already reconciled to errored is left alone (returns "skipped").
 *
 * task-027 (fraud engine): after the completion transaction commits, the
 * XBR-022 trigger evaluation runs via evaluateFraudTriggersForResult — see
 * the marked block at the end of this function.
 */
export async function recordCheckOutcome(
  input: RecordCheckOutcomeInput,
): Promise<"completed" | "errored" | "skipped"> {
  const { resultId, applicationId, checkType, outcome, actor, meta } = input;

  const recorded = await prisma.$transaction(async (tx) => {
    const row = await tx.underwritingResult.findUnique({ where: { id: resultId } });
    if (!row || row.status !== "running") return "skipped";

    const completedAt = new Date();

    if (outcome.ok) {
      const { summary, riskBadge } = summarize(checkType, outcome.result);
      await tx.underwritingResult.update({
        where: { id: resultId },
        data: {
          status: "completed",
          completedAt,
          // VERBATIM §A wire payload — serialized back to the client unchanged.
          result: outcome.result as unknown as Prisma.InputJsonValue,
          summary,
          riskBadge: riskBadge ?? null,
          error: null,
        },
      });
      if (checkType === "aus") {
        // INV-030 "blocking T15 until re-run": the completed re-run clears the mirror flag.
        await tx.application.update({ where: { id: applicationId }, data: { ausStale: false } });
      }
      if (checkType === "avm") {
        // §E / ASM-006: a fresh AVM value just became available — the stored
        // Application.ltv/cltv (MISMO 106-108, LAR 80/81) must move to the
        // min(estimatedValue, avmValue) basis via THE shared module, in-tx.
        await persistApplicationQualification(applicationId, tx);
      }
      await audit(tx as AuditTransactionClient, {
        actor: actor.userId,
        role: actor.role,
        actionType: "underwriting-check",
        applicationId,
        entityType: "UnderwritingResult",
        entityId: resultId,
        summary,
        ip: meta.ip,
        requestId: meta.requestId,
      });

      // §4.8.2 caseworker trigger "underwriting check or AUS result recorded"
      // — via THE notification service (task-036), in-tx, to the active
      // assignee (no-op when unassigned).
      await notifyAssignedCaseworkerOfResult(tx, applicationId, checkType, summary);

      return "completed";
    }

    const errorSummary = `${checkType}: error — ${outcome.failure.message}`;
    await tx.underwritingResult.update({
      where: { id: resultId },
      data: { status: "error", completedAt, error: outcome.failure.message },
    });
    if (checkType === "avm") {
      // §E / ASM-006: the re-run superseded the prior AVM result at start time
      // and then errored, so no fresh AVM value is available — the stored
      // ltv/cltv revert to the estimatedValue basis, in-tx.
      await persistApplicationQualification(applicationId, tx);
    }
    await audit(tx as AuditTransactionClient, {
      actor: actor.userId,
      role: actor.role,
      actionType: "underwriting-check",
      applicationId,
      entityType: "UnderwritingResult",
      entityId: resultId,
      summary: errorSummary,
      ip: meta.ip,
      requestId: meta.requestId,
    });
    // §4.8.2: an errored result is also a recorded result — notify the assignee.
    await notifyAssignedCaseworkerOfResult(tx, applicationId, checkType, errorSummary);
    return "errored";
  });

  // ------------------------------------------------------------------
  // XBR-022 fraud-trigger evaluation (task-027): after the completion
  // transaction COMMITS, evaluate the check-driven triggers (income variance
  // >20%, AVM <85% of stated, employer not verified) against the recorded
  // result + live application data. Runs in its OWN transaction (flag write +
  // audit atomic with each other) and NEVER throws (INV-018) — so a fraud-
  // evaluation failure can neither roll back nor break the recorded outcome.
  // ------------------------------------------------------------------
  if (recorded === "completed") {
    await evaluateFraudTriggersForResult(resultId);
  }

  return recorded;
}

// ---------------------------------------------------------------------------
// startUnderwritingCheck — POST /api/applications/:id/checks/:checkType
// ---------------------------------------------------------------------------

export interface StartCheckResult {
  /**
   * false = an identical check was already in flight and this request was
   * "ignored server-side" (§4.6.5): the EXISTING running row is returned and
   * no new run started. Both variants respond 202 with UnderwritingResultInfo.
   */
  started: boolean;
  info: UnderwritingResultInfo;
  /**
   * The async execution (provider run + latency sleep + recordCheckOutcome),
   * already in flight and never rejecting. Routes pass it to next/server
   * `after()` so the 202 returns first; evidence scripts await it directly.
   * Null when started=false.
   */
  execution: Promise<void> | null;
}

/**
 * SEC-21 + INV-031 + ASYNC-005 entry point. Validates the record-level and
 * state gates, assembles LIVE provider inputs, creates the `running` row
 * (superseding the prior current result of this type — history retained),
 * and launches the non-blocking execution. Duplicate-in-flight requests are
 * decided by the DB partial unique index, never check-then-act.
 */
export async function startUnderwritingCheck(
  user: SessionUser,
  applicationId: string,
  checkType: CheckType,
  meta: RequestMetaBundle,
): Promise<StartCheckResult> {
  // Defense in depth — the route roleGate already excludes borrowers.
  if (user.role === "BORROWER") {
    throw new HttpProblem(403, ERROR_CODES.forbidden, "Only staff may run underwriting checks");
  }

  // Lazy reconciler pass (cheap guarded query — ASYNC-005 crash recovery).
  await reconcileStuckUnderwritingChecks(applicationId);

  // SEC-21 record gate: active assignment (caseworker) or Supervisor.
  const access = await canWriteApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found") {
      throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
    }
    throw new HttpProblem(
      403,
      ERROR_CODES.forbidden,
      "You are not assigned to this application",
    );
  }

  // SEC-21 state gate: states 3-8 only → 409 otherwise.
  const state = access.application.workflowState;
  if (!CHECK_ELIGIBLE_STATES.includes(state)) {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      `Underwriting checks may only run between Completeness & Consistency Validated and Conditional Approval — this application is in ${workflowStateLabel(state)}`,
    );
  }

  // LIVE input assembly (throws 409 for missing data / AUS prerequisites).
  const ctx = await loadLiveContext(applicationId);
  const prepared = await prepareProviderCall(checkType, ctx);

  // Row-before-response with the DB in-flight lock deciding duplicates.
  const created = await createRunningRow(user, applicationId, checkType, prepared.providerName);
  if (created.kind === "already-running") {
    return { started: false, info: toUnderwritingResultInfo(created.row), execution: null };
  }

  const actor = { userId: user.userId, role: user.role as "CASEWORKER" | "SUPERVISOR" };
  const resultId = created.row.id;

  // ASYNC DISPATCH: genuinely CALL the provider seam, apply its latency with a
  // non-blocking sleep OUTSIDE any transaction, then record the real output in
  // the second transaction. The promise never rejects (unexpected failures are
  // recorded as retryable errored results — a crash mid-flight is covered by
  // the reconciler).
  const execution = (async () => {
    try {
      const outcome = await prepared.execute();
      await sleep(outcome.latencyMs);
      await recordCheckOutcome({ resultId, applicationId, checkType, outcome, actor, meta });
    } catch (err) {
      try {
        await recordCheckOutcome({
          resultId,
          applicationId,
          checkType,
          outcome: {
            ok: false,
            failure: {
              code: "unavailable",
              message: `The ${checkType} check failed unexpectedly. Retry the check.`,
              retryable: true,
            },
            latencyMs: 0,
          },
          actor,
          meta,
        });
      } catch (recordErr) {
        // Last resort: the reconciler will mark the stuck row errored.
        console.error(`underwriting-check ${resultId}: failed to record outcome`, recordErr);
      }
      console.error(`underwriting-check ${resultId}: execution error`, err);
    }
  })();

  return { started: true, info: toUnderwritingResultInfo(created.row), execution };
}

type CreateRowOutcome =
  | { kind: "created"; row: ResultRowWithRequester }
  | { kind: "already-running"; row: ResultRowWithRequester };

/**
 * Create the `running` row and supersede the prior current result of this type
 * in one transaction. INV-031: the partial unique index on (applicationId,
 * checkType) WHERE status='running' is the single authority on duplicates —
 * P2002 means a run is already in flight, and the §4.6.5 idempotent-while-
 * in-flight semantics return that existing row. Small retry loop covers the
 * rare interleaving where the running row completes between the P2002 and the
 * re-read.
 */
async function createRunningRow(
  user: SessionUser,
  applicationId: string,
  checkType: CheckType,
  providerName: string,
): Promise<CreateRowOutcome> {
  const requesterInclude = { requestedByUser: { select: { firstName: true, lastName: true } } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const createdRow = await tx.underwritingResult.create({
          data: {
            applicationId,
            checkType,
            status: "running",
            provider: providerName,
            requestedByUserId: user.userId,
            isStale: false,
          },
          include: requesterInclude,
        });
        // Re-run replaces the current result, retaining history (INV-031/§4.6.5):
        // every prior non-superseded row of this type now points at the new run.
        await tx.underwritingResult.updateMany({
          where: {
            applicationId,
            checkType,
            supersededById: null,
            id: { not: createdRow.id },
          },
          data: { supersededById: createdRow.id },
        });
        return createdRow;
      });
      return { kind: "created", row };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await prisma.underwritingResult.findFirst({
          where: { applicationId, checkType, status: "running" },
          include: requesterInclude,
        });
        if (existing) return { kind: "already-running", row: existing };
        continue; // the in-flight run finished between P2002 and the read — retry the create
      }
      throw err;
    }
  }
  throw new HttpProblem(
    409,
    ERROR_CODES.conflict,
    `A ${checkType} check is already running for this application`,
  );
}

// ---------------------------------------------------------------------------
// listUnderwritingResults — GET /api/applications/:id/checks (max 25, no pagination)
// ---------------------------------------------------------------------------

/**
 * UnderwritingResultList: newest-first, capped at 25 rows (§B "none (max 25)").
 * The current result per check type (supersededById = null) is ALWAYS included
 * — history rows fill the remaining capacity — so the panel can render every
 * check's current state even on a long history.
 */
export async function listUnderwritingResults(applicationId: string): Promise<UnderwritingResultList> {
  const requesterInclude = { requestedByUser: { select: { firstName: true, lastName: true } } };
  const current = await prisma.underwritingResult.findMany({
    where: { applicationId, supersededById: null },
    orderBy: { requestedAt: "desc" },
    include: requesterInclude,
    take: 25,
  });
  const history = await prisma.underwritingResult.findMany({
    where: { applicationId, supersededById: { not: null } },
    orderBy: { requestedAt: "desc" },
    include: requesterInclude,
    take: Math.max(0, 25 - current.length),
  });
  const rows = [...current, ...history].sort(
    (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime(),
  );
  return { rows: rows.map(toUnderwritingResultInfo) };
}

// ---------------------------------------------------------------------------
// getQualificationSummary — GET /api/applications/:id/qualification
// ---------------------------------------------------------------------------

/** Wire shape per contracts.json models.QualificationSummary — exact field names. */
export interface QualificationSummary {
  middleCreditScore?: number;
  creditTier?: "good" | "fair" | "poor";
  dti?: number;
  ltv?: number;
  cltv?: number;
  estimatedMonthlyPiti?: number;
  ausRecommendation?: "approve-eligible" | "refer" | "refer-with-caution";
  escalationRequired: boolean;
  escalationCriteriaMet?: string[];
  overallStatus: "qualified" | "review" | "not-qualified";
}

/**
 * §4.6.5 qualification summary card, composed entirely from live data:
 *   - dti/ltv/cltv: THE shared qualification module (AC-13) — field-for-field
 *     identical to computeApplicationQualification.
 *   - middleCreditScore/creditTier: current completed credit result
 *     (qualifyingScore = ASM-003 lower-of-middles).
 *   - estimatedMonthlyPiti: current completed pricing result's par scenario.
 *   - ausRecommendation: current completed AUS result.
 *   - escalation: the live task-020 evaluation (same thresholds/config as the
 *     approval gate — AC-32 threshold changes flip this immediately).
 *   - overallStatus (contract fixes the enum but not the mapping — documented
 *     interpretation): approve-eligible → qualified; refer-with-caution →
 *     not-qualified; refer or no AUS result yet → review.
 */
export async function getQualificationSummary(applicationId: string): Promise<QualificationSummary> {
  const qualification = await computeApplicationQualification(applicationId);
  const [creditRow, pricingRow, ausRow] = await Promise.all([
    currentResult(applicationId, "credit"),
    currentResult(applicationId, "pricing"),
    currentResult(applicationId, "aus"),
  ]);
  // The global client is structurally a Prisma.TransactionClient; the
  // evaluation is read-only so no transaction is required here.
  const escalation = await evaluateEscalation(prisma, applicationId);

  const credit = currentCreditPayload(creditRow);
  const pricing =
    pricingRow && pricingRow.status === "completed"
      ? (asObject(pricingRow.result) as unknown as PricingCheckResult | null)
      : null;
  const aus =
    ausRow && ausRow.status === "completed"
      ? (asObject(ausRow.result) as unknown as AusCheckResult | null)
      : null;

  const parScenario = pricing?.scenarios?.find((s) => s.name === "par") ?? pricing?.scenarios?.[0];

  const summary: QualificationSummary = {
    escalationRequired: escalation.required,
    escalationCriteriaMet: escalation.metLabels,
    overallStatus:
      aus?.recommendation === "approve-eligible"
        ? "qualified"
        : aus?.recommendation === "refer-with-caution"
          ? "not-qualified"
          : "review",
  };
  const middleCreditScore = credit?.qualifyingScore ?? credit?.middleScore;
  if (typeof middleCreditScore === "number") summary.middleCreditScore = middleCreditScore;
  if (credit?.riskTier) summary.creditTier = credit.riskTier;
  if (qualification.dti !== null) summary.dti = qualification.dti;
  if (qualification.ltv !== null) summary.ltv = qualification.ltv;
  if (qualification.cltv !== null) summary.cltv = qualification.cltv;
  if (typeof parScenario?.monthlyPiti === "number") summary.estimatedMonthlyPiti = parScenario.monthlyPiti;
  if (aus?.recommendation) summary.ausRecommendation = aus.recommendation;
  return summary;
}
