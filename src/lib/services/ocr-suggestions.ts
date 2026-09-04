// OCR apply-suggestion service (task-035 — REQ-067, NFR-017 (SEC-16),
// NFR-007 (SEC-6), XBR-018, AC-45).
//
// POST /api/documents/:id/ocr/apply-suggestion → CorrectionInfo 200
//
// SERVER-AUTHORITATIVE COMPOSITION: the endpoint composes the SAME gates as
// POST /api/applications/:id/corrections by delegating the write to
// recordCorrection (src/lib/services/corrections.ts — the single correction
// write path): active-assignment-or-Supervisor scoping (403), the five
// staff-editable states (409 with currentState), schema validation of the
// target field, in-tx audit (actionType "correction"), DTI/LTV recalc,
// staleness marking, signature re-derivation. NOTHING here re-implements or
// re-derives that state machine; this module only
//   1. scopes the document + extraction (RECORD-LEVEL SCOPING — mirrors
//      requireOcrDocumentAccess in document-ocr.ts: unknown/unowned → 404 with
//      no existence disclosure, unassigned caseworker → 403),
//   2. requires the extraction to belong to the document's CURRENT version
//      (XBR-016 posture — a superseded extraction is a 409),
//   3. translates the extraction fieldPath onto the one application scalar a
//      correction can write (src/lib/pure/ocr-apply-targets.ts) with the same
//      record-selection predicates the extraction's entered data was
//      assembled from (document-ocr.ts assembleEnteredData),
//   4. passes sourceDocumentId so the audit envelope carries the XBR-018 /
//      SEC-16 source-document provenance.
//
// Server-side only — never import from client components.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { recordCorrection, type CorrectionInfo } from "@/lib/services/corrections";
import type { OcrExtractedField } from "@/lib/services/ocr";
import {
  OCR_APPLY_TARGETS,
  OCR_NAME_SPANNING_PATHS,
  parseOcrExtractedValue,
} from "@/lib/pure/ocr-apply-targets";
import type { ApplySuggestionRequest } from "@/lib/schemas/ocr";

function validationProblem(details: string[]): HttpProblem {
  return new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
    details,
  });
}

function asObjectArray(value: Prisma.JsonValue | null | undefined): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Prisma.JsonObject =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  ) as Record<string, unknown>[];
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Resolve the concrete corrections fieldPath (+ borrowerOrdinal) for an
 * applyable extraction fieldPath, using the SAME record-selection predicates
 * as document-ocr.ts assembleEnteredData — the record the extraction compared
 * against is the record the suggestion is applied to.
 */
async function resolveTargetPath(
  applicationId: string,
  ocrFieldPath: string,
): Promise<{ fieldPath: string; borrowerOrdinal?: number }> {
  const target = OCR_APPLY_TARGETS[ocrFieldPath]!;

  if (target.scope === "borrower-dob") {
    return { fieldPath: "dateOfBirth", borrowerOrdinal: 1 };
  }

  if (target.scope === "employment") {
    const borrower = await prisma.borrower.findUnique({
      where: { applicationId_ordinal: { applicationId, ordinal: 1 } },
      select: { employments: true },
    });
    const index = asObjectArray(borrower?.employments).findIndex((e) =>
      nonEmptyString(e.employerName),
    );
    if (index < 0) {
      throw validationProblem([
        `fieldPath: "${ocrFieldPath}" cannot be applied — the primary borrower has no employment record with an employer name to correct`,
      ]);
    }
    return { fieldPath: `employments[${index}].${target.leaf}`, borrowerOrdinal: 1 };
  }

  const data = await prisma.applicationData.findUnique({
    where: { applicationId },
    select: { assets: true, otherCredits: true },
  });

  if (target.scope === "asset") {
    const index = asObjectArray(data?.assets).findIndex(
      (a) => nonEmptyString(a.financialInstitution) || finiteNumber(a.cashOrMarketValue),
    );
    if (index < 0) {
      throw validationProblem([
        `fieldPath: "${ocrFieldPath}" cannot be applied — the application has no asset record to correct`,
      ]);
    }
    return { fieldPath: `assets[${index}].${target.leaf}` };
  }

  // gift
  const index = asObjectArray(data?.otherCredits).findIndex(
    (c) => c.type === "gift-of-cash" || c.type === "gift-of-equity",
  );
  if (index < 0) {
    throw validationProblem([
      `fieldPath: "${ocrFieldPath}" cannot be applied — the application has no gift-type credit record to correct`,
    ]);
  }
  return { fieldPath: `otherCredits[${index}].${target.leaf}` };
}

/**
 * Apply one extracted OCR value to the application as an audited correction
 * (SEC-16 / XBR-018). Throws HttpProblem: 404 (unknown/unowned document or
 * extraction — no existence disclosure), 403 (caseworker without the active
 * assignment), 409 (superseded extraction, or — via recordCorrection — a state
 * that does not permit corrections), 400 (unknown / compare-only / unmapped
 * field, unparsable extracted value, target-schema rejection).
 */
export async function applyOcrSuggestion(
  user: SessionUser,
  documentId: string,
  request: ApplySuggestionRequest,
  meta: RequestMetaBundle,
): Promise<CorrectionInfo> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, applicationId: true, currentVersionId: true },
  });
  if (!doc || !doc.currentVersionId) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Document not found");
  }

  // SEC-6 / S-3 / S-4 record scoping BEFORE any extraction detail leaks.
  const access = await canWriteApplication(user, doc.applicationId);
  if (!access.allowed) {
    if (access.reason === "not-assigned") {
      throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
    }
    throw new HttpProblem(404, ERROR_CODES.notFound, "Document not found");
  }

  const extraction = await prisma.ocrExtraction.findUnique({
    where: { id: request.extractionId },
    select: {
      id: true,
      documentVersionId: true,
      fields: true,
      documentVersion: { select: { documentId: true, originalFileName: true } },
    },
  });
  if (!extraction || extraction.documentVersion.documentId !== doc.id) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Extraction not found for this document");
  }
  if (extraction.documentVersionId !== doc.currentVersionId) {
    // XBR-016: checklist and OCR operate on the current version — an
    // extraction from a replaced upload must not write into the application.
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "This extraction belongs to a superseded document version — re-run OCR on the current version before applying suggestions",
    );
  }

  const rawFields: unknown[] = Array.isArray(extraction.fields)
    ? (extraction.fields as unknown[])
    : [];
  const fields = rawFields.filter(
    (row): row is OcrExtractedField =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as { fieldPath?: unknown }).fieldPath === "string" &&
      typeof (row as { extractedValue?: unknown }).extractedValue === "string",
  );
  const field = fields.find((row) => row.fieldPath === request.fieldPath);
  if (!field) {
    throw validationProblem([
      `fieldPath: "${request.fieldPath}" is not a field of this extraction`,
    ]);
  }

  if (OCR_NAME_SPANNING_PATHS.has(request.fieldPath)) {
    throw validationProblem([
      `fieldPath: "${request.fieldPath}" spans the borrower's first and last name and cannot be applied as one correction — use inline corrections on the name fields instead`,
    ]);
  }
  const target = OCR_APPLY_TARGETS[request.fieldPath];
  if (!target) {
    throw validationProblem([
      `fieldPath: "${request.fieldPath}" has no mapped application field — apply-suggestion is available for comparison-view fields only`,
    ]);
  }
  if (field.mapped !== true) {
    throw validationProblem([
      `fieldPath: "${request.fieldPath}" was not mapped to borrower-entered data in this extraction and cannot be applied`,
    ]);
  }

  const parsed = parseOcrExtractedValue(target.valueKind, field.extractedValue);
  if (!parsed.ok) {
    throw validationProblem([`fieldPath: "${request.fieldPath}" — ${parsed.message}`]);
  }

  const { fieldPath, borrowerOrdinal } = await resolveTargetPath(
    doc.applicationId,
    request.fieldPath,
  );

  // §A / INV-039: apply-suggestion IS a correction-bearing write, so the stamp
  // it verifies must be the CLIENT's (VR-130) — the one the panel captured
  // from the surface's last GET. Reading it server-side here would make the
  // check vacuous: a suggestion held from a stale view would overwrite a
  // concurrent correction and still report success. The stamp travels through
  // the SAME recordCorrection conditional update as the corrections and
  // section-save call sites, so a stale stamp yields the identical 409 body.
  const reasonInput = request.reason?.trim();
  const reason = (
    reasonInput && reasonInput.length > 0
      ? reasonInput
      : `Applied OCR suggestion for ${request.fieldPath} from "${extraction.documentVersion.originalFileName}"`
  ).slice(0, 500);

  // The single correction write path (SEC-6 assignment + staff-editable-state
  // 409 + schema validation + in-tx audit); sourceDocumentId = the XBR-018 /
  // SEC-16 source-document provenance in the audit envelope.
  return recordCorrection(
    user,
    doc.applicationId,
    {
      versionStamp: request.versionStamp,
      fieldPath,
      ...(borrowerOrdinal !== undefined ? { borrowerOrdinal } : {}),
      newValue: JSON.stringify(parsed.value),
      reason,
      sourceDocumentId: doc.id,
    },
    meta,
  );
}
