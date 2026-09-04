// Fraud flag engine (task-027 — REQ-060, §4.6.6/§4.7, XBR-017/021/022,
// INV-018/021/030, VR-118/119, AC-38).
//
// FIVE AUTOMATIC TRIGGERS (§4.6.6):
//   1. ocr-mismatch        — OCR-extracted values differ materially from entered
//                            values (§4.7: income variance > 20%, balance
//                            variance > 25%, name or DOB mismatch, employer
//                            mismatch). Evaluated by `evaluateOcrTriggers`
//                            (XBR-017 seam — production caller is the task-034
//                            OCR worker, increment 8; fully implemented and
//                            evidence-covered NOW).
//   2. income-variance     — VERIFIED income variance > 20% (recorded income
//                            check; IncomeVerificationRow.variancePct is the
//                            ABSOLUTE magnitude — see §6.3.2 / task-024 note).
//   3. avm-low             — AVM value < 85% of the STATED (estimated) value.
//   4. duplicate-ssn       — SSN blind-index match on another borrower's
//                            application (XBR-021 — the identity-save path in
//                            src/lib/services/application-data.ts creates this
//                            flag through `createFraudFlagsInTx` below;
//                            INV-018: never blocks the save or submission).
//   5. employer-unverified — stated employer not verified (§6.3.2 "UNVERIFIED"
//                            employer → not found → employerVerified=false).
// Triggers 2/3/5 run on check completion via the XBR-022 hook in
// src/lib/services/underwriting-checks.ts `recordCheckOutcome` →
// `evaluateFraudTriggersForResult`.
//
// SEVERITY MAPPING — INTERPRETATION (documented): §4.6.6 fixes the severity
// enum (low/medium/high) but does not assign per-type severities. This build's
// mapping, consistent with the XBR-021 code landed in increment 3 and with
// AC-38 ("a high-severity open flag blocks Preliminary Decision" after the
// factor-9 income scenario):
//   duplicate-ssn      → high   (identity fraud indicator; increment-3 precedent)
//   income-variance    → high   (§6.3.2 calls the factor-9 30% variance
//                                "material, fraud flag"; the AC-38 blocking
//                                scenario is this flag)
//   employer-unverified→ medium (employer not found — needs review)
//   avm-low            → medium (valuation concern; the escalation path
//                                handles low AVM separately)
//   ocr-mismatch       → high when a NAME or DOB mismatch is among the material
//                        findings (identity-document discrepancy), else medium
//                        (numeric variance / employer mismatch).
//
// DEDUPLICATION — INTERPRETATION (documented): §4.6.6 does not state dedup
// semantics. Rule used (matches the XBR-021 precedent): a candidate is skipped
// while an OPEN flag with the same (applicationId, type, sourceDocumentVersionId)
// exists. Check-driven and duplicate-ssn flags carry no sourceDocumentVersionId,
// so they dedupe per (applicationId, type) while open — re-running a check
// (which records a NEW UnderwritingResult) re-detecting the same condition does
// not spam duplicate open flags. Resolving/dismissing a flag re-arms the
// trigger: if a later evaluation detects the condition again, a new flag is
// created (detection-then-review, not suppression).
//
// THRESHOLDS: fixed in the RFP text (§4.6.6 ">20%", "<85%"; §4.7 ">20%",
// ">25%"). §4.6.11's SystemConfig registry defines NO fraud keys and is frozen
// — the thresholds are compile-time constants here, not configuration.
//
// INV-018 (never block): every automatic evaluation entry point below catches
// its own failures and logs them with console.error — a fraud-evaluation
// failure is never thrown into the triggering save/check/OCR path. (For
// XBR-021, which shares the identity-save transaction so that flag + audit
// commit atomically with the save, the call site catches JS-level errors the
// same way.)
//
// INV-021 (same-application source refs): `createFraudFlagsInTx` verifies that
// sourceDocumentVersionId / sourceResultId reference entities of the SAME
// application and throws otherwise — evaluators only ever construct in-app
// references, so a violation is a programming error surfaced loudly (and
// caught by the never-throw wrappers on the automatic paths).
//
// AUDIT (REQ-060 "flag creation and resolution are audited"): both are written
// through the task-003 in-transaction audit service in the SAME transaction as
// the flag write, actionType "fraud-flag". Creation is a SYSTEM action (the
// flags are automatic); resolution is audited with the session actor.
//
// NOTIFICATION (§4.8.2 "fraud flag created" → caseworker): flag creation
// notifies the holder of the current active assignment in the same transaction
// (in-tx notification-row pattern shared with task-020/021/022 — the task-036
// notification service will absorb these call sites).

import type { FraudFlag, FraudFlagSeverity, FraudFlagStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canReadApplication, canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import type { AvmCheckResult, IncomeCheckResult } from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// Contract enums (contracts.json, verbatim literals)
// ---------------------------------------------------------------------------

/** contracts.json enums.FraudFlagType, verbatim. */
export const FRAUD_FLAG_TYPE_VALUES = [
  "ocr-mismatch",
  "income-variance",
  "avm-low",
  "duplicate-ssn",
  "employer-unverified",
] as const;
export type FraudFlagTypeValue = (typeof FRAUD_FLAG_TYPE_VALUES)[number];

/** contracts.json enums.FraudFlagStatus, verbatim (Prisma enum mirrors it). */
export const FRAUD_FLAG_STATUS_VALUES = ["open", "resolved", "dismissed"] as const;

// ---------------------------------------------------------------------------
// Thresholds (fixed RFP text — see module header; NOT SystemConfig)
// ---------------------------------------------------------------------------

/** §4.6.6: verified income variance strictly greater than 20% flags. */
export const VERIFIED_INCOME_VARIANCE_THRESHOLD_PCT = 20;
/** §4.7: OCR income variance strictly greater than 20% is material. */
export const OCR_INCOME_VARIANCE_THRESHOLD_PCT = 20;
/** §4.7: OCR balance variance strictly greater than 25% is material. */
export const OCR_BALANCE_VARIANCE_THRESHOLD_PCT = 25;
/** §4.6.6: AVM value strictly less than 85% of the stated value flags. */
export const AVM_LOW_VALUE_RATIO = 0.85;

// ---------------------------------------------------------------------------
// FraudFlagInfo serializer (contracts §A — field names verbatim)
// ---------------------------------------------------------------------------

/** Wire shape per contracts.json models.FraudFlagInfo — exact field names. */
export interface FraudFlagInfo {
  id: string;
  applicationId: string;
  type: FraudFlagTypeValue;
  severity: FraudFlagSeverity;
  sourceDocumentVersionId?: string;
  sourceResultId?: string;
  details: string;
  status: FraudFlagStatus;
  resolvedByName?: string;
  resolutionNote?: string;
  resolvedAt?: string;
  createdAt: string;
}

/** contracts.json models.FraudFlagList. */
export interface FraudFlagList {
  rows: FraudFlagInfo[];
}

type FlagRowWithResolver = FraudFlag & {
  resolvedByUser?: { firstName: string; lastName: string } | null;
};

export function toFraudFlagInfo(row: FlagRowWithResolver): FraudFlagInfo {
  const info: FraudFlagInfo = {
    id: row.id,
    applicationId: row.applicationId,
    type: row.type as FraudFlagTypeValue,
    severity: row.severity,
    details: row.details,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.sourceDocumentVersionId !== null) info.sourceDocumentVersionId = row.sourceDocumentVersionId;
  if (row.sourceResultId !== null) info.sourceResultId = row.sourceResultId;
  if (row.resolvedByUser) {
    const name = `${row.resolvedByUser.firstName} ${row.resolvedByUser.lastName}`.trim();
    if (name.length > 0) info.resolvedByName = name;
  }
  if (row.resolutionNote !== null) info.resolutionNote = row.resolutionNote;
  if (row.resolvedAt !== null) info.resolvedAt = row.resolvedAt.toISOString();
  return info;
}

// ---------------------------------------------------------------------------
// Candidates + shared in-transaction creator (dedup, INV-021, audit, notify)
// ---------------------------------------------------------------------------

export interface FraudFlagCandidate {
  type: FraudFlagTypeValue;
  severity: FraudFlagSeverity;
  details: string;
  /** DocumentVersion.id on the SAME application (INV-021) — OCR flags only. */
  sourceDocumentVersionId?: string;
  /** UnderwritingResult.id on the SAME application (INV-021) — check flags only. */
  sourceResultId?: string;
}

/**
 * Create fraud flags inside the caller's open transaction, so the flag write,
 * its audit entry, and the caseworker notification commit atomically with the
 * triggering operation's recording. Enforces INV-021 (same-application source
 * references — throws on violation) and the dedup rule from the module header
 * (skip while an identical-keyed OPEN flag exists).
 *
 * @returns the created rows (deduped/skipped candidates are absent).
 */
export async function createFraudFlagsInTx(
  tx: AuditTransactionClient,
  applicationId: string,
  candidates: FraudFlagCandidate[],
  meta?: Pick<RequestMetaBundle, "ip" | "requestId">,
): Promise<FraudFlag[]> {
  if (candidates.length === 0) return [];

  const application = await tx.application.findUnique({
    where: { id: applicationId },
    select: { id: true, applicationNumber: true },
  });
  if (!application) {
    throw new Error(`createFraudFlagsInTx: application ${applicationId} not found`);
  }
  const activeAssignment = await tx.caseworkerAssignment.findFirst({
    where: { applicationId, endedAt: null },
    select: { caseworkerUserId: true },
  });

  const created: FraudFlag[] = [];
  for (const candidate of candidates) {
    // INV-021: source references must belong to THIS application.
    if (candidate.sourceResultId !== undefined) {
      const result = await tx.underwritingResult.findUnique({
        where: { id: candidate.sourceResultId },
        select: { applicationId: true },
      });
      if (!result || result.applicationId !== applicationId) {
        throw new Error(
          `INV-021 violation: sourceResultId ${candidate.sourceResultId} does not reference an UnderwritingResult of application ${applicationId}`,
        );
      }
    }
    if (candidate.sourceDocumentVersionId !== undefined) {
      const version = await tx.documentVersion.findUnique({
        where: { id: candidate.sourceDocumentVersionId },
        select: { document: { select: { applicationId: true } } },
      });
      if (!version || version.document.applicationId !== applicationId) {
        throw new Error(
          `INV-021 violation: sourceDocumentVersionId ${candidate.sourceDocumentVersionId} does not reference a DocumentVersion of application ${applicationId}`,
        );
      }
    }

    // Dedup (module header): skip while an identical-keyed OPEN flag exists.
    const existing = await tx.fraudFlag.findFirst({
      where: {
        applicationId,
        type: candidate.type,
        status: "open",
        sourceDocumentVersionId: candidate.sourceDocumentVersionId ?? null,
      },
      select: { id: true },
    });
    if (existing) continue;

    const flag = await tx.fraudFlag.create({
      data: {
        applicationId,
        type: candidate.type,
        severity: candidate.severity,
        sourceDocumentVersionId: candidate.sourceDocumentVersionId ?? null,
        sourceResultId: candidate.sourceResultId ?? null,
        details: candidate.details,
        status: "open",
      },
    });
    created.push(flag);

    // REQ-060: creation audited in the same transaction. SYSTEM actor — the
    // flags are created automatically, never by a user request body.
    await audit(tx, {
      actor: null,
      role: "SYSTEM",
      actionType: "fraud-flag",
      applicationId,
      entityType: "FraudFlag",
      entityId: flag.id,
      summary: `fraud flag created: ${candidate.type} (${candidate.severity}) — ${candidate.details}`,
      ip: meta?.ip ?? null,
      requestId: meta?.requestId ?? null,
    });

    // §4.8.2 caseworker trigger "fraud flag created" — via THE notification
    // service (task-036, §4.8.1), in-tx, to the current active assignee
    // (no-op when unassigned).
    if (activeAssignment) {
      await createNotification(tx, {
        recipientUserId: activeAssignment.caseworkerUserId,
        type: "fraud-flag-created",
        title: "Fraud flag created",
        body: `A ${candidate.severity}-severity ${candidate.type} fraud flag was created on application ${application.applicationNumber}: ${candidate.details}`,
        applicationId,
      });
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Pure trigger predicates — LIVE-STATE: consume the recorded result payloads
// and application data handed in by the evaluators, never constants.
// ---------------------------------------------------------------------------

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Triggers 2 + 5 from a recorded income check (§4.6.6):
 *   income-variance    — a VERIFIED employment row whose variancePct (absolute
 *                        magnitude, §6.3.2/task-024) is STRICTLY > 20.
 *   employer-unverified— an employment row with employerVerified === false.
 * Rows without a variancePct (no stated income → nothing to compare) are
 * tolerated silently (missing-source tolerance, XBR-022).
 */
export function incomeCheckCandidates(
  income: IncomeCheckResult,
  sourceResultId: string,
): FraudFlagCandidate[] {
  const candidates: FraudFlagCandidate[] = [];
  const rows = Array.isArray(income.employments) ? income.employments : [];

  const varianceRows = rows.filter(
    (row) =>
      row.employerVerified === true &&
      typeof row.variancePct === "number" &&
      Number.isFinite(row.variancePct) &&
      row.variancePct > VERIFIED_INCOME_VARIANCE_THRESHOLD_PCT,
  );
  if (varianceRows.length > 0) {
    const parts = varianceRows.map(
      (row) =>
        `${row.employerName}: verified ${
          typeof row.verifiedMonthlyIncome === "number" ? formatUsd(row.verifiedMonthlyIncome) : "n/a"
        }/mo vs stated ${
          typeof row.statedMonthlyIncome === "number" ? formatUsd(row.statedMonthlyIncome) : "n/a"
        }/mo (variance ${row.variancePct!.toFixed(1)}%)`,
    );
    candidates.push({
      type: "income-variance",
      severity: "high",
      sourceResultId,
      details: `Verified income variance exceeds ${VERIFIED_INCOME_VARIANCE_THRESHOLD_PCT}% — ${parts.join("; ")}.`,
    });
  }

  const unverifiedRows = rows.filter((row) => row.employerVerified === false);
  if (unverifiedRows.length > 0) {
    const names = unverifiedRows.map((row) => row.employerName).join(", ");
    candidates.push({
      type: "employer-unverified",
      severity: "medium",
      sourceResultId,
      details: `Stated employer could not be verified: ${names}.`,
    });
  }

  return candidates;
}

/**
 * Trigger 3 from a recorded AVM check (§4.6.6): AVM estimated value STRICTLY
 * below 85% of the STATED (borrower-estimated) property value. A missing or
 * non-positive stated value means there is nothing to compare — tolerated
 * silently (missing-source tolerance, XBR-022). Exactly 85% does NOT flag.
 */
export function avmCheckCandidate(
  avm: AvmCheckResult,
  statedValue: number | null,
  sourceResultId: string,
): FraudFlagCandidate | null {
  if (
    typeof statedValue !== "number" ||
    !Number.isFinite(statedValue) ||
    statedValue <= 0 ||
    typeof avm.estimatedValue !== "number" ||
    !Number.isFinite(avm.estimatedValue)
  ) {
    return null;
  }
  if (avm.estimatedValue >= statedValue * AVM_LOW_VALUE_RATIO) return null;
  const ratioPct = (avm.estimatedValue / statedValue) * 100;
  return {
    type: "avm-low",
    severity: "medium",
    sourceResultId,
    details: `AVM value ${formatUsd(avm.estimatedValue)} is ${ratioPct.toFixed(1)}% of the stated value ${formatUsd(statedValue)} (below the ${AVM_LOW_VALUE_RATIO * 100}% threshold).`,
  };
}

// ---------------------------------------------------------------------------
// OCR material-variance predicates (§4.7 — trigger 1, XBR-017)
// ---------------------------------------------------------------------------

/**
 * The §4.7 comparison kinds for mapped fields (employer name, base monthly
 * income, account balance, name, DOB). `classifyOcrFieldPath` maps an
 * OcrFieldResult.fieldPath onto a kind by its TERMINAL SEGMENT — the task-034
 * extractor should emit mapped fieldPaths whose last dot-segment matches these
 * tokens (e.g. "employment.employerName", "employment.baseMonthlyIncome",
 * "account.endingBalance", "borrower.name", "borrower.dateOfBirth").
 */
export type OcrComparisonKind = "employer" | "income" | "balance" | "name" | "dob";

export function classifyOcrFieldPath(fieldPath: string): OcrComparisonKind | null {
  const segment = fieldPath.split(".").pop()?.toLowerCase() ?? "";
  if (segment.includes("employer")) return "employer";
  if (segment.includes("income") || segment.includes("grosspay") || segment.includes("wages")) return "income";
  if (segment.includes("balance")) return "balance";
  if (segment.includes("dob") || segment.includes("birth")) return "dob";
  if (segment.includes("name")) return "name";
  return null;
}

/** The slice of contracts §A OcrFieldResult the predicates consume. */
export interface OcrFieldLike {
  fieldPath: string;
  extractedValue: string;
  enteredValue?: string;
  variancePct?: number;
  mapped?: boolean;
}

export interface OcrMaterialFinding {
  kind: OcrComparisonKind;
  fieldPath: string;
  detail: string;
  /** Name/DOB mismatches are identity-document discrepancies → high severity. */
  identityMismatch: boolean;
}

function parseNumeric(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (cleaned.length === 0) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Date-aware equality for DOB values; falls back to normalized text. */
function dobMatches(a: string, b: string): boolean {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (!Number.isNaN(pa) && !Number.isNaN(pb)) {
    return new Date(pa).toISOString().slice(0, 10) === new Date(pb).toISOString().slice(0, 10);
  }
  return normalizeText(a) === normalizeText(b);
}

/**
 * Absolute percentage variance (VR-134): stored variancePct when present and
 * FINITE, else computed as |extracted − entered| ÷ |entered| × 100 with the
 * borrower-ENTERED value as the denominator.
 *
 * Degenerate denominator (VR-134): entered = 0 with a non-zero extracted value
 * is INFINITE variance — a stated $0 against a documented amount is always
 * material, so every threshold fires. Both zero is 0% variance. Infinity is not
 * JSON-representable, so OcrFieldResult.variancePct is ABSENT in that case on
 * the wire and the stored-value short-circuit above (Number.isFinite) correctly
 * falls through to this computed branch.
 */
function fieldVariancePct(field: OcrFieldLike): number | null {
  if (typeof field.variancePct === "number" && Number.isFinite(field.variancePct)) {
    return Math.abs(field.variancePct);
  }
  if (field.enteredValue === undefined) return null;
  const extracted = parseNumeric(field.extractedValue);
  const entered = parseNumeric(field.enteredValue);
  if (extracted === null || entered === null) return null;
  if (entered === 0) return extracted === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (Math.abs(extracted - entered) / Math.abs(entered)) * 100;
}

/**
 * §4.7 material-difference predicates over an extraction's field rows:
 *   income variance > 20%, balance variance > 25% (strict), name or DOB
 *   mismatch, employer mismatch. Fields without an entered counterpart
 *   (enteredValue absent or mapped === false) have nothing to compare and are
 *   tolerated silently. Boundary values (exactly 20% / 25%) do NOT flag.
 */
export function ocrMaterialFindings(fields: OcrFieldLike[]): OcrMaterialFinding[] {
  const findings: OcrMaterialFinding[] = [];
  for (const field of fields) {
    if (field.mapped === false || field.enteredValue === undefined) continue;
    const kind = classifyOcrFieldPath(field.fieldPath);
    if (kind === null) continue;

    if (kind === "income" || kind === "balance") {
      const threshold =
        kind === "income" ? OCR_INCOME_VARIANCE_THRESHOLD_PCT : OCR_BALANCE_VARIANCE_THRESHOLD_PCT;
      const variance = fieldVariancePct(field);
      if (variance !== null && variance > threshold) {
        findings.push({
          kind,
          fieldPath: field.fieldPath,
          identityMismatch: false,
          detail: `${field.fieldPath}: extracted "${field.extractedValue}" vs entered "${field.enteredValue}" (variance ${
            Number.isFinite(variance) ? `${variance.toFixed(1)}%` : "unbounded (entered value is 0)"
          } > ${threshold}%)`,
        });
      }
      continue;
    }

    const matches =
      kind === "dob"
        ? dobMatches(field.extractedValue, field.enteredValue)
        : normalizeText(field.extractedValue) === normalizeText(field.enteredValue);
    if (!matches) {
      findings.push({
        kind,
        fieldPath: field.fieldPath,
        identityMismatch: kind === "name" || kind === "dob",
        detail: `${field.fieldPath}: extracted "${field.extractedValue}" does not match entered "${field.enteredValue}"`,
      });
    }
  }
  return findings;
}

/** One ocr-mismatch candidate per document version, enumerating all findings. */
export function ocrMismatchCandidate(
  findings: OcrMaterialFinding[],
  sourceDocumentVersionId: string,
): FraudFlagCandidate | null {
  if (findings.length === 0) return null;
  return {
    type: "ocr-mismatch",
    severity: findings.some((f) => f.identityMismatch) ? "high" : "medium",
    sourceDocumentVersionId,
    details: `OCR-extracted values differ materially from entered values — ${findings
      .map((f) => f.detail)
      .join("; ")}.`,
  };
}

// ---------------------------------------------------------------------------
// evaluateFraudTriggersForResult — XBR-022 hook (called by recordCheckOutcome)
// ---------------------------------------------------------------------------

/**
 * Evaluate the check-driven triggers (income variance > 20%, AVM < 85% of
 * stated, employer not verified) for a COMPLETED UnderwritingResult, creating
 * flags that reference it via sourceResultId. Runs in its OWN transaction
 * immediately after the completion-recording transaction commits (the flag
 * write and its audit entry are atomic with each other), so a fraud-evaluation
 * failure can never roll back the recorded check outcome.
 *
 * NEVER THROWS (INV-018 posture): failures are logged with console.error.
 * Missing sources — a non-income/avm check type, a missing payload, an
 * employment row without stated income, a subject property without a stated
 * value — evaluate to "no flags" without error (XBR-022 tolerance).
 *
 * @returns the number of flags created (0 on tolerated-missing or failure).
 */
export async function evaluateFraudTriggersForResult(resultId: string): Promise<number> {
  try {
    const created = await prisma.$transaction(async (tx) => {
      const result = await tx.underwritingResult.findUnique({
        where: { id: resultId },
        select: { id: true, applicationId: true, checkType: true, status: true, result: true },
      });
      if (!result || result.status !== "completed") return [];
      if (result.checkType !== "income" && result.checkType !== "avm") return [];
      const payload =
        typeof result.result === "object" && result.result !== null && !Array.isArray(result.result)
          ? (result.result as Record<string, unknown>)
          : null;
      if (!payload) return [];

      let candidates: FraudFlagCandidate[] = [];
      if (result.checkType === "income") {
        candidates = incomeCheckCandidates(payload as unknown as IncomeCheckResult, result.id);
      } else {
        // Stated value from the LIVE application data (§4.6.6 "of stated value").
        const data = await tx.applicationData.findUnique({
          where: { applicationId: result.applicationId },
          select: { subjectProperty: true },
        });
        const subject =
          typeof data?.subjectProperty === "object" &&
          data.subjectProperty !== null &&
          !Array.isArray(data.subjectProperty)
            ? (data.subjectProperty as Record<string, unknown>)
            : null;
        const statedValue =
          typeof subject?.estimatedValue === "number" && Number.isFinite(subject.estimatedValue)
            ? subject.estimatedValue
            : null;
        const candidate = avmCheckCandidate(
          payload as unknown as AvmCheckResult,
          statedValue,
          result.id,
        );
        if (candidate) candidates = [candidate];
      }
      return createFraudFlagsInTx(tx as AuditTransactionClient, result.applicationId, candidates);
    });
    return created.length;
  } catch (err) {
    // INV-018: fraud evaluation never breaks the check-recording path.
    console.error(`fraud: trigger evaluation failed for result ${resultId}`, err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// evaluateOcrTriggers — XBR-017 seam (production caller: task-034 OCR worker)
// ---------------------------------------------------------------------------

/**
 * Evaluate the §4.7 OCR material-variance trigger for a document version:
 * reads the LATEST OcrExtraction recorded for it, applies the material-
 * difference predicates to its stored field rows (extracted vs entered), and
 * creates at most one ocr-mismatch flag referencing the document version
 * (INV-021 — same application by construction, verified by the creator).
 *
 * NEVER THROWS (INV-018 posture): failures are logged. Missing sources — an
 * unknown document version, no extraction yet, no mapped/entered fields —
 * evaluate to "no flags" without error.
 *
 * XBR-017 sequencing: OcrExtraction rows are produced by the task-034 worker
 * (increment 8), which calls this on OCR completion. The evaluation is fully
 * implemented and evidence-covered now (task-027 scripts create extraction
 * rows directly).
 *
 * @returns the number of flags created (0 on tolerated-missing or failure).
 */
export async function evaluateOcrTriggers(documentVersionId: string): Promise<number> {
  try {
    const created = await prisma.$transaction(async (tx) => {
      const version = await tx.documentVersion.findUnique({
        where: { id: documentVersionId },
        select: { id: true, document: { select: { applicationId: true } } },
      });
      if (!version) return [];
      const extraction = await tx.ocrExtraction.findFirst({
        where: { documentVersionId },
        orderBy: { createdAt: "desc" },
        select: { fields: true },
      });
      if (!extraction || !Array.isArray(extraction.fields)) return [];

      const fields = (extraction.fields as unknown[]).filter(
        (row): row is OcrFieldLike =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as OcrFieldLike).fieldPath === "string" &&
          typeof (row as OcrFieldLike).extractedValue === "string",
      );
      const candidate = ocrMismatchCandidate(ocrMaterialFindings(fields), documentVersionId);
      if (!candidate) return [];
      return createFraudFlagsInTx(
        tx as AuditTransactionClient,
        version.document.applicationId,
        [candidate],
      );
    });
    return created.length;
  } catch (err) {
    console.error(`fraud: OCR trigger evaluation failed for document version ${documentVersionId}`, err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// listFraudFlags — GET /api/applications/:id/fraud-flags (max 50)
// ---------------------------------------------------------------------------

/**
 * FraudFlagList for the detail page (§4.6.6): newest-first, capped at 50 rows
 * (§B "none (max 50)"). RECORD-LEVEL SCOPING: caseworkers need the current
 * ACTIVE assignment (S-2a) — summary-level queue visibility never exposes
 * fraud detail; supervisors read everything (S-4).
 */
export async function listFraudFlags(user: SessionUser, applicationId: string): Promise<FraudFlagList> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found") {
      throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
    }
    throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
  }
  if (access.level !== "full") {
    throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
  }

  const rows = await prisma.fraudFlag.findMany({
    where: { applicationId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { resolvedByUser: { select: { firstName: true, lastName: true } } },
  });
  return { rows: rows.map(toFraudFlagInfo) };
}

// ---------------------------------------------------------------------------
// resolveFraudFlag — POST /api/fraud-flags/:id/resolve
// ---------------------------------------------------------------------------

export interface FraudFlagResolveBody {
  /** contracts §A FraudFlagResolveRequest.status (FraudFlagStatus). */
  status: FraudFlagStatus;
  /** contracts §A FraudFlagResolveRequest.resolutionNote (VR-119 non-empty). */
  resolutionNote: string;
}

/**
 * Resolve or dismiss a fraud flag (§4.6.6, VR-118/119, §3.3):
 *   - VR-118: target status must be resolved or dismissed — never open (400);
 *     dismissal of a HIGH-severity flag is Supervisor-only (403).
 *   - VR-119: resolutionNote required non-empty (400).
 *   - RECORD-LEVEL SCOPING: the flag is loaded, then its application's access
 *     verified — a caseworker must hold the current ACTIVE assignment (403);
 *     supervisors go through the SAME transactional path (admin-endpoint
 *     invariant).
 *   - Already resolved/dismissed → 409 (guarded update decides races).
 *   - Resolver identity comes from the SESSION only; resolvedAt/note recorded;
 *     audited in the same transaction (REQ-060).
 * The T15 gate (task-019) counts live open high-severity rows, so resolving or
 * dismissing the last one makes T15 passable with no extra state.
 */
export async function resolveFraudFlag(
  user: SessionUser,
  flagId: string,
  body: FraudFlagResolveBody,
  meta: RequestMetaBundle,
): Promise<FraudFlagInfo> {
  // Defense in depth — the route roleGate already excludes borrowers.
  if (user.role === "BORROWER") {
    throw new HttpProblem(403, ERROR_CODES.forbidden, "Only staff may resolve fraud flags");
  }

  // VR-118 cross-field (status enum membership is the route schema's job).
  if (body.status === "open") {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: ["status: must be resolved or dismissed (a flag cannot be re-opened via resolve)"],
    });
  }
  // VR-119.
  if (body.resolutionNote.trim().length === 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: ["resolutionNote: a resolution note is required"],
    });
  }

  const flag = await prisma.fraudFlag.findUnique({
    where: { id: flagId },
    select: { id: true, applicationId: true, severity: true, status: true },
  });
  if (!flag) throw new HttpProblem(404, ERROR_CODES.notFound, "Fraud flag not found");

  // RECORD-LEVEL SCOPING (§3.3 "Fraud flag resolution: caseworker ✔ (a)"):
  // active assignment required for caseworkers; supervisors allowed (S-4).
  const access = await canWriteApplication(user, flag.applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found") {
      throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
    }
    throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
  }

  // VR-118: high-severity dismissal is Supervisor-only (§4.6.6 "until resolved
  // or dismissed by a Supervisor"; caseworkers may RESOLVE any severity and
  // dismiss non-high flags).
  if (body.status === "dismissed" && flag.severity === "high" && user.role !== "SUPERVISOR") {
    throw new HttpProblem(
      403,
      ERROR_CODES.forbidden,
      "Dismissing a high-severity fraud flag requires a Supervisor",
    );
  }

  const resolvedAt = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    // Guarded update: only an OPEN flag transitions — a concurrent resolve
    // loses with count 0 (never check-then-act).
    const result = await tx.fraudFlag.updateMany({
      where: { id: flagId, status: "open" },
      data: {
        status: body.status,
        resolvedByUserId: user.userId,
        resolutionNote: body.resolutionNote,
        resolvedAt,
      },
    });
    if (result.count === 0) {
      throw new HttpProblem(
        409,
        ERROR_CODES.conflict,
        "This fraud flag has already been resolved or dismissed",
      );
    }
    const row = await tx.fraudFlag.findUniqueOrThrow({
      where: { id: flagId },
      include: { resolvedByUser: { select: { firstName: true, lastName: true } } },
    });
    // REQ-060: resolution audited in the same transaction, session actor only.
    await audit(tx as AuditTransactionClient, {
      actor: user.userId,
      role: user.role,
      actionType: "fraud-flag",
      applicationId: flag.applicationId,
      entityType: "FraudFlag",
      entityId: flagId,
      summary: `fraud flag ${body.status}: ${row.type} (${row.severity}) — ${body.resolutionNote.trim()}`,
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return row;
  });

  return toFraudFlagInfo(updated);
}
