// Shared masked application-graph loader for per-application exports
// (task-040 — wave-1 shared plumbing; MISMO JSON + XML both read THIS, and
// task-041's URLA PDF reuses it read-only).
//
// Reuse posture (builder-common): this module does NOT hand-roll a new
// projection — borrower and section data flow through the task-011 canonical
// serializers (serializeBorrower / serializeApplicationData), so every export
// inherits the S-5/SEC-1/SEC-2 masking guarantees:
//   - SSN egress is ssnMasked (***-**-NNNN via the single task-002 masking
//     module). The ONLY unmasked egress is the MISMO full-SSN mode: when
//     `fullSsn: true` (Supervisor + audited reason, enforced by the caller)
//     `ssnExportValue` carries the decrypted SSN normalized to NNN-NN-NNNN.
//   - DOB egress is ALWAYS dateOfBirthDisplay ("Mon D, YYYY") — SEC-2: raw
//     ISO DOB never leaves the owner identity endpoint, including on full-SSN
//     exports (documented interpretation: the contract's full mode unmasks
//     the SSN only).
//   - Account-number encryption envelopes are STRIPPED; only *Last4 survives.
//
// The load is ONE application's bounded graph (SEC-14 note in builder-common:
// per-application exports may load a single graph; streaming applies to the
// global LAR/warehouse exports).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { decryptField } from "@/lib/crypto/encryption";
import { normalizeSsn } from "@/lib/crypto/ssn";
import {
  APPLICATION_INCLUDE,
  serializeApplicationData,
  serializeBorrower,
  serializeSignature,
  type ApplicationWithRelations,
} from "@/lib/services/application-serializer";

/** One borrower, in the masked wire projection plus the export SSN value. */
export interface ExportBorrower extends Record<string, unknown> {
  ordinal: number;
  /**
   * The SSN string this export emits: ***-**-NNNN by default; the decrypted
   * SSN as NNN-NN-NNNN only when the loader was called with fullSsn: true.
   * Undefined when no SSN has been captured for the borrower.
   */
  ssnExportValue?: string;
}

/** Application-level facts exports read (all live row data — never defaults). */
export interface ExportApplicationFacts {
  id: string;
  applicationNumber: string;
  workflowState: string;
  submittedAt: string | null;
  decidedAt: string | null;
  outcome: string | null;
  /** Stored task-010 shared-module values (AC-13 — never re-derived here). */
  dti: number | null;
  ltv: number | null;
  cltv: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationExportData {
  application: ExportApplicationFacts;
  borrowers: ExportBorrower[];
  /** serializeApplicationData output (envelopes stripped): assets, otherCredits,
   *  realEstateOwned, liabilities, otherLiabilities, subjectProperty, loan,
   *  proposedHousingExpense — keys absent when never saved. */
  data: Record<string, unknown>;
  /** SignatureInfo wire projections (no image bytes) — URLA PDF metadata. */
  signatures: Record<string, unknown>[];
  /** Raw Signature rows (image bytes included) for the task-041 PDF embed. */
  signatureRows: ApplicationWithRelations["signatures"];
  /** ASM-003 qualifying score from the latest completed, non-superseded credit
   *  check result, when one exists (stored value — the shared module wrote it). */
  creditQualifyingScore: number | null;
  /** Latest completed, non-superseded, NON-stale AVM estimated value (ASM-006:
   *  a stale AVM result is not available), when one exists. */
  avmValue: number | null;
  /** ISO timestamp of this load (export generation time). */
  generatedAt: string;
}

function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/** Decrypt + normalize the full SSN to NNN-NN-NNNN. Null when not captured. */
function decryptFullSsn(row: ApplicationWithRelations["borrowers"][number]): string | null {
  if (!row.ssnCiphertext || !row.ssnKeyId) return null;
  const raw = decryptField({ ciphertext: row.ssnCiphertext, keyId: row.ssnKeyId });
  const digits = normalizeSsn(raw);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function numberField(value: Prisma.JsonValue | null | undefined, key: string): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

/**
 * Load one application's full masked export graph. Throws HttpProblem 404 when
 * the application does not exist (callers normally run requireExportableApplication
 * first — this is the race backstop).
 */
export async function loadApplicationExportData(
  applicationId: string,
  opts: { fullSsn?: boolean } = {},
): Promise<ApplicationExportData> {
  const row = (await prisma.application.findUnique({
    where: { id: applicationId },
    include: APPLICATION_INCLUDE,
  })) as ApplicationWithRelations | null;
  if (!row) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  }

  // Latest completed, non-superseded credit + AVM results (live stored values).
  const checkRows = await prisma.underwritingResult.findMany({
    where: {
      applicationId,
      checkType: { in: ["credit", "avm"] },
      status: "completed",
      supersededById: null,
    },
    orderBy: [{ completedAt: "desc" }, { requestedAt: "desc" }],
    select: { checkType: true, isStale: true, result: true },
  });
  const creditRow = checkRows.find((r) => r.checkType === "credit") ?? null;
  const avmRow = checkRows.find((r) => r.checkType === "avm") ?? null;

  const borrowers: ExportBorrower[] = row.borrowers.map((b) => {
    const wire = serializeBorrower(b);
    const ssnExportValue = opts.fullSsn
      ? decryptFullSsn(b) ?? undefined
      : (wire.ssnMasked as string | undefined);
    return { ...wire, ordinal: b.ordinal, ssnExportValue };
  });

  return {
    application: {
      id: row.id,
      applicationNumber: row.applicationNumber,
      workflowState: row.workflowState,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      outcome: row.outcome ?? null,
      dti: decimalToNumber(row.dti),
      ltv: decimalToNumber(row.ltv),
      cltv: decimalToNumber(row.cltv),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    borrowers,
    data: serializeApplicationData(row.data) ?? {},
    signatures: row.signatures.map((s) => serializeSignature(s)),
    signatureRows: row.signatures,
    creditQualifyingScore: numberField(creditRow?.result, "qualifyingScore"),
    avmValue: avmRow && !avmRow.isStale ? numberField(avmRow.result, "estimatedValue") : null,
    generatedAt: new Date().toISOString(),
  };
}
