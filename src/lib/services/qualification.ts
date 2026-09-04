// Shared DTI / LTV / CLTV qualification SERVICE (task-010, REQ-036, NFR-008,
// SEC-7, AC-13).
//
// >>> SINGLE IMPLEMENTATION — AC-13 <<<
// This module is THE qualification entry point for every subsystem: wizard
// section save (SectionSaveResponse.dti/ltv/cltv), corrections recalc,
// qualification summary card, AUS, analytics DTI/LTV bands, and the HMDA LAR
// export. Later increments MUST import this module (or the pure core it
// delegates to) — never re-derive the formulas — so identical data yields
// identical results at every call site.
//
// Layering (functional core / imperative shell):
//   - Formulas live in src/lib/pure/qualification.ts (pure, deterministic,
//     §E-documented). This wrapper only (1) loads live rows, (2) maps them to
//     the pure input shape, (3) reads thresholds from the SystemConfig service
//     (NEVER hardcoded — live-state rule), (4) returns ratios + evaluations.
//   - No PII decryption: the ratios read only plaintext currency/enum fields;
//     encrypted account-number envelopes inside the JSON rows are untouched.
//
// Server-side only — never import from client components.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getNumberSetting } from "@/lib/services/config";
import {
  computeQualification,
  type AvmAvailabilityInput,
  type BorrowerIncomeInput,
  type QualificationInput,
  type QualificationResult,
  type QualificationThresholds,
} from "@/lib/pure/qualification";

/** Works inside or outside a transaction (corrections/saves recalc in-tx). */
export type QualificationDbClient = PrismaClient | Prisma.TransactionClient;

/** Service result: SectionSaveResponse-compatible dti/ltv/cltv + evaluations. */
export interface ApplicationQualification extends QualificationResult {
  /** The live SystemConfig thresholds the evaluations ran against. */
  thresholds: QualificationThresholds;
}

// ---------------------------------------------------------------------------
// Row -> pure-input mapping (field names verbatim from contracts.json; values
// pass through untouched so the pure module's INV-025 validation stays the
// single authority — a corrupted row fails loudly, it does not silently skew
// a ratio).
// ---------------------------------------------------------------------------

function asArray(value: Prisma.JsonValue | null | undefined): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => typeof row === "object" && row !== null && !Array.isArray(row))
    .map((row) => row as Record<string, unknown>);
}

function asObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

interface BorrowerIncomeRows {
  employments: Prisma.JsonValue | null;
  otherIncome: Prisma.JsonValue | null;
}

interface ApplicationDataRows {
  realEstateOwned: Prisma.JsonValue | null;
  liabilities: Prisma.JsonValue | null;
  otherLiabilities: Prisma.JsonValue | null;
  subjectProperty: Prisma.JsonValue | null;
  loan: Prisma.JsonValue | null;
  proposedHousingExpense: Prisma.JsonValue | null;
}

interface AvmResultRow {
  isStale: boolean;
  status: string;
  result: Prisma.JsonValue | null;
}

/**
 * Map live rows to the pure QualificationInput. Exported so verification (and
 * any consumer proving AC-13) can call the pure core with EXACTLY the mapping
 * the service uses.
 */
export function buildQualificationInput(
  borrowers: readonly BorrowerIncomeRows[],
  data: ApplicationDataRows | null,
  avmRow: AvmResultRow | null,
): QualificationInput {
  const borrowerInputs: BorrowerIncomeInput[] = borrowers.map((b) => ({
    employments: asArray(b.employments).map((e) => ({
      baseMonthlyIncome: e.baseMonthlyIncome as number | null | undefined,
      overtime: e.overtime as number | null | undefined,
      bonus: e.bonus as number | null | undefined,
      commission: e.commission as number | null | undefined,
      militaryEntitlements: e.militaryEntitlements as number | null | undefined,
      otherMonthlyIncome: e.otherMonthlyIncome as number | null | undefined,
      selfEmployedMonthlyIncome: e.selfEmployedMonthlyIncome as number | null | undefined,
    })),
    otherIncome: asArray(b.otherIncome).map((o) => ({
      source: o.source as string | null | undefined,
      monthlyAmount: o.monthlyAmount as number | null | undefined,
    })),
  }));

  const subjectProperty = asObject(data?.subjectProperty ?? null);
  const loan = asObject(data?.loan ?? null);
  const proposedHousingExpense = asObject(data?.proposedHousingExpense ?? null);

  // ASM-006: the AVM value is offered to the pure predicate together with the
  // UnderwritingResult staleness fields; availability is decided THERE.
  const avmResult = asObject(avmRow?.result ?? null);
  const avm: AvmAvailabilityInput | null = avmRow
    ? {
        estimatedValue: avmResult?.estimatedValue as number | null | undefined,
        status: avmRow.status,
        isStale: avmRow.isStale,
      }
    : null;

  return {
    borrowers: borrowerInputs,
    realEstateOwned: asArray(data?.realEstateOwned ?? null).map((r) => ({
      netMonthlyRentalIncome: r.netMonthlyRentalIncome as number | null | undefined,
    })),
    liabilities: asArray(data?.liabilities ?? null).map((l) => ({
      monthlyPayment: l.monthlyPayment as number | null | undefined,
      paidOffAtClosing: l.paidOffAtClosing as boolean | null | undefined,
    })),
    otherLiabilities: asArray(data?.otherLiabilities ?? null).map((l) => ({
      monthlyPayment: l.monthlyPayment as number | null | undefined,
    })),
    proposedHousingExpense: proposedHousingExpense
      ? {
          firstMortgagePi: proposedHousingExpense.firstMortgagePi as number | null | undefined,
          subordinateLiens: proposedHousingExpense.subordinateLiens as number | null | undefined,
          homeownersInsurance: proposedHousingExpense.homeownersInsurance as number | null | undefined,
          supplementalInsurance: proposedHousingExpense.supplementalInsurance as number | null | undefined,
          propertyTaxes: proposedHousingExpense.propertyTaxes as number | null | undefined,
          mortgageInsurance: proposedHousingExpense.mortgageInsurance as number | null | undefined,
          hoaDues: proposedHousingExpense.hoaDues as number | null | undefined,
          other: proposedHousingExpense.other as number | null | undefined,
        }
      : null,
    // SubjectProperty.expectedMonthlyRentalIncome is mapped but EXCLUDED from
    // income by the pure core (§E, ASM-002); estimatedValue feeds LTV.
    subjectProperty: subjectProperty
      ? {
          estimatedValue: subjectProperty.estimatedValue as number | null | undefined,
          expectedMonthlyRentalIncome: subjectProperty.expectedMonthlyRentalIncome as
            | number
            | null
            | undefined,
        }
      : null,
    requestedLoanAmount: loan?.requestedLoanAmount as number | null | undefined,
    estimatedValue: subjectProperty?.estimatedValue as number | null | undefined,
    avm,
    otherNewMortgages: asArray(loan?.otherNewMortgages as Prisma.JsonValue | undefined).map((m) => ({
      lienType: m.lienType as string | null | undefined,
      amount: m.amount as number | null | undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Live loads
// ---------------------------------------------------------------------------

/** Live SystemConfig thresholds via the config service's typed getters (INV-024 — never hardcoded). */
export async function getQualificationThresholds(): Promise<QualificationThresholds> {
  const [dtiWarningPercent, ltvWarningPercent, ltvSubmissionBlockPercent] = await Promise.all([
    getNumberSetting("dti.warningPercent"),
    getNumberSetting("ltv.warningPercent"),
    getNumberSetting("ltv.submissionBlockPercent"),
  ]);
  return { dtiWarningPercent, ltvWarningPercent, ltvSubmissionBlockPercent };
}

/**
 * Load an application's live income/liability/property/loan rows and map them
 * to the pure input shape. Exported for consumers that need the input itself
 * (e.g. determinism evidence); most callers use computeApplicationQualification.
 * Throws when the application does not exist.
 */
export async function loadQualificationInput(
  applicationId: string,
  db: QualificationDbClient = prisma,
): Promise<QualificationInput> {
  // Sequential on purpose: `db` may be an interactive-transaction client
  // (saves/corrections recalc in-tx), which does not support concurrent queries.
  const application = await db.application.findUnique({
    where: { id: applicationId },
    select: { id: true },
  });
  const borrowers = await db.borrower.findMany({
    where: { applicationId },
    orderBy: { ordinal: "asc" },
    select: { employments: true, otherIncome: true },
  });
  const data = await db.applicationData.findUnique({
    where: { applicationId },
    select: {
      realEstateOwned: true,
      liabilities: true,
      otherLiabilities: true,
      subjectProperty: true,
      loan: true,
      proposedHousingExpense: true,
    },
  });
  // Latest completed, non-superseded AVM result; its isStale flag feeds the
  // ASM-006 availability predicate (stale => stated value governs LTV).
  const avmRow = await db.underwritingResult.findFirst({
    where: { applicationId, checkType: "avm", status: "completed", supersededById: null },
    orderBy: [{ completedAt: "desc" }, { requestedAt: "desc" }],
    select: { isStale: true, status: true, result: true },
  });

  if (!application) {
    throw new Error(`qualification: application ${applicationId} not found`);
  }

  return buildQualificationInput(
    borrowers,
    data,
    avmRow ? { isStale: avmRow.isStale, status: avmRow.status, result: avmRow.result } : null,
  );
}

/**
 * THE shared qualification call (AC-13): live rows + live SystemConfig
 * thresholds -> §E ratios (percent, 3 dp — SectionSaveResponse-compatible
 * dti/ltv/cltv) + warning/block evaluations. Pass an open transaction client
 * as `db` to evaluate inside a save/correction transaction.
 */
export async function computeApplicationQualification(
  applicationId: string,
  db: QualificationDbClient = prisma,
): Promise<ApplicationQualification> {
  const input = await loadQualificationInput(applicationId, db);
  const thresholds = await getQualificationThresholds();
  return { ...computeQualification(input, thresholds), thresholds };
}

/**
 * Recompute the §E ratios via THE shared module and persist them onto the
 * stored Application.dti/ltv/cltv columns (the values MISMO entries 106-108,
 * HMDA LAR fields 80/81, and every wire serializer read).
 *
 * §E / ASM-006: the LTV/CLTV denominator is min(estimatedValue, avmValue) only
 * while a fresh (completed, non-superseded, non-stale) AVM result exists — so
 * the stored columns must be refreshed at EVERY point where such a result
 * appears or disappears, not only on section saves/corrections. Callers:
 *   - recordCheckOutcome (task-025): a fresh AVM outcome is recorded (a
 *     superseding re-run lands on the new value; an errored re-run reverts to
 *     the estimatedValue basis, the prior result having been superseded).
 *   - markChecksStale / the engine's markUnderwritingStale: an AVM result is
 *     marked stale and stops being "available" (ASM-006).
 * TRANSACTION-ONLY: runs on the caller's open transaction so the persisted
 * ratios are atomic with the change that moved them.
 */
export async function persistApplicationQualification(
  applicationId: string,
  tx: Prisma.TransactionClient,
): Promise<ApplicationQualification> {
  const qualification = await computeApplicationQualification(applicationId, tx);
  await tx.application.update({
    where: { id: applicationId },
    data: { dti: qualification.dti, ltv: qualification.ltv, cltv: qualification.cltv },
  });
  return qualification;
}
