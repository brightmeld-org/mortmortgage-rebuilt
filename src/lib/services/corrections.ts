// Field-level corrections service (task-023) — POST/GET /api/applications/:id/corrections.
//
// REQ-050, NFR-007 (SEC-6), NFR-008 (SEC-7), VR-089..VR-092, XBR-004, INV-021,
// INV-030, AC-25, AC-34.
//
// STORAGE DECISION (documented for the record):
//   The RFP §9 entity inventory defines NO Correction entity, and §4.4.4 defines
//   a correction as a field-level edit "recorded in the same database
//   transaction as an audit entry containing field path, before value, after
//   value, user, timestamp, and reason". The Prisma schema (complete §9 set,
//   increment 1) accordingly has no Correction model, and the audit vocabulary
//   already includes actionType "correction". A correction is therefore
//   PERSISTED AS its audit entry: the data change (Borrower / ApplicationData
//   update) and one AuditLogEntry(actionType "correction") are written in one
//   prisma.$transaction, and CorrectionInfo / CorrectionPage are served as a
//   PROJECTION of those audit rows (CorrectionInfo.id = AuditLogEntry.id;
//   correctedByName/Role from the actor user; fieldPath/borrowerOrdinal/values
//   from the structured before/after envelopes written below). Nothing in
//   contracts.md §A CorrectionInfo requires a separate table — every wire field
//   maps onto the audit row — so no additive migration is needed.
//
// SEMANTICS:
//   - Assigned caseworker or Supervisor only (SEC-6; canWriteApplication —
//     403 not-assigned, 404 unknown), in the five staff-editable states only
//     (§4.4.4 — 409 with currentState otherwise).
//   - `newValue` is a JSON-encoded SCALAR (VR-091) validated against the target
//     field's contract schema (type/enum/range) by walking the same zod schemas
//     the wizard save uses — the serialization contract, not an approximation.
//   - NEVER creates an ApplicationVersion and never touches workflowState
//     (§4.4.6 "corrections do not create versions" — that rule is about
//     ApplicationVersion snapshots, not the concurrency stamp).
//   - OPTIMISTIC CONCURRENCY (§A, INV-039, §B 409): a correction IS a write to
//     the Application, so it carries and verifies Application.versionStamp
//     through THE mechanism the section-save and transition call sites use —
//     the stamp in the WHERE clause of the conditional update, incremented on
//     success. A stale stamp is rejected 409 with the standard ErrorResponse
//     and the whole transaction rolls back, so a lost update can never be
//     recorded in the audit trail as a deliberate sequential edit.
//   - Every correction recalculates DTI/LTV/CLTV via THE shared qualification
//     module (AC-13) and persists them — identical to the wizard-save path.
//     (Recalc on non-relevant fields is a deterministic no-op.)
//   - Related underwriting results are marked stale per §4.6.5 via the shared
//     staleness helper; corrections to income / liability / housing-expense /
//     loan-amount / property-value / down-payment fields mark the AUS result
//     stale (Application.ausStale mirrored), blocking T15 until re-run
//     (XBR-004 / INV-030 — the T15 gate lives in the workflow engine).
//   - XBR-003 posture: a correction is an application-data edit, so signature
//     validity is re-derived (dataHash comparison) in the same transaction.
//   - INV-021: corrections write scalar values into rows loaded BY this
//     application's id only (Borrower by (applicationId, ordinal),
//     ApplicationData by applicationId); no cross-entity reference fields are
//     writable through fieldPath (row `id`s are denied), so every recorded
//     reference stays within the application structurally.
//   - Encrypted fields: ssn (VR-069) and dateOfBirth are re-encrypted through
//     the task-002 helpers with last4/blind-index upkeep; row accountNumber
//     leaves are stored as embedded envelopes with the sibling
//     accountNumberLast4 refreshed. Audit rows and CorrectionInfo values carry
//     MASKED SSN (***-**-NNNN) and masked account numbers (****NNNN) — never
//     plaintext secrets (S-5/SEC-8 posture). DOB is carried as its
//     dateOfBirthDisplay form ("Mon D, YYYY", via THE masking module): per
//     NFR-003/SEC-2 the raw ISO DOB never leaves the identity-own endpoint, and
//     corrections/audit are not that endpoint.
//
// Server-side only — never import from client components.

import { Prisma, type CheckType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { pageEnvelope, type PageEnvelope, type Pagination } from "@/lib/http/pagination";
import { audit } from "@/lib/services/audit";
import { computeApplicationQualification } from "@/lib/services/qualification";
import { invalidateSignaturesOnDataChange } from "@/lib/services/signature-validity";
import { withServerGeocode } from "@/lib/services/geocoding";
import { markChecksStale } from "@/lib/services/underwriting-staleness";
import { encryptField, encryptFieldToJson } from "@/lib/crypto/encryption";
import { decryptField } from "@/lib/crypto/encryption";
import { ssnBlindIndex, ssnLast4 } from "@/lib/crypto/ssn";
import { formatDobDisplay } from "@/lib/crypto/masking";
import {
  addressHistorySectionSchema,
  assetRecordSchema,
  borrowerIdentitySectionSchema,
  declarationsSchema,
  demographicsSchema,
  employmentSectionSchema,
  liabilityRecordSchema,
  loanDetailsSchema,
  otherCreditRecordSchema,
  otherLiabilityRecordSchema,
  proposedHousingExpenseSchema,
  realEstateOwnedRecordSchema,
  subjectPropertySchema,
} from "@/lib/schemas/application";
import { type CorrectionRequest } from "@/lib/schemas/corrections";

// ---------------------------------------------------------------------------
// Wire shape (contracts.md §A CorrectionInfo — exact field names)
// ---------------------------------------------------------------------------

export interface CorrectionInfo {
  id: string;
  applicationId: string;
  fieldPath: string;
  borrowerOrdinal?: number;
  beforeValue?: string;
  afterValue: string;
  correctedByName: string;
  correctedByRole: string;
  correctedAt: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Staff-editable states (§4.4.4, SEC-6) — canonical WorkflowState literals
// ---------------------------------------------------------------------------

export const STAFF_EDITABLE_STATES = [
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
] as const;

// ---------------------------------------------------------------------------
// fieldPath grammar: key ( "." key | "[" index "]" )*
// ---------------------------------------------------------------------------

type PathSeg = { kind: "key"; key: string } | { kind: "index"; index: number };

function parseFieldPath(path: string): PathSeg[] | null {
  const segs: PathSeg[] = [];
  const re = /(?:^|\.)([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m.index !== last) return null;
    last = re.lastIndex;
    if (m[1] !== undefined) segs.push({ kind: "key", key: m[1] });
    else segs.push({ kind: "index", index: Number(m[2]) });
  }
  if (last !== path.length || segs.length === 0) return null;
  if (segs[0].kind !== "key") return null;
  return segs;
}

// ---------------------------------------------------------------------------
// Root schemas — the STORED data layout (contracts.md §A BorrowerRecord /
// ApplicationData), composed from the task-011 request schemas so field
// names, enum literals, and ranges stay single-sourced.
// ---------------------------------------------------------------------------

// mailingAddressDifferent is a UI toggle, not a stored borrower field.
const { mailingAddressDifferent: _uiToggle, ...addressHistoryStorageShape } =
  addressHistorySectionSchema.shape;

const borrowerRootSchema = z.object({
  ...borrowerIdentitySectionSchema.shape, // includes write-shape ssn / dateOfBirth
  ...addressHistoryStorageShape,
  ...employmentSectionSchema.shape,
  declarations: declarationsSchema,
  demographics: demographicsSchema,
});

const sharedRootSchema = z.object({
  assets: z.array(assetRecordSchema),
  otherCredits: z.array(otherCreditRecordSchema),
  realEstateOwned: z.array(realEstateOwnedRecordSchema),
  liabilities: z.array(liabilityRecordSchema),
  otherLiabilities: z.array(otherLiabilityRecordSchema),
  subjectProperty: subjectPropertySchema,
  loan: loanDetailsSchema,
  proposedHousingExpense: proposedHousingExpenseSchema,
});

const BORROWER_ROOTS = new Set(Object.keys(borrowerRootSchema.shape));
const SHARED_ROOTS = new Set(Object.keys(sharedRootSchema.shape));

/** Borrower columns stored as JSON documents (walked with the generic setter). */
const BORROWER_JSON_COLUMNS = new Set([
  "militaryService",
  "currentAddress",
  "previousAddresses",
  "mailingAddress",
  "employments",
  "previousEmployments",
  "otherIncome",
  "declarations",
  "demographics",
]);

/** Borrower scalar-array columns (String[]). */
const BORROWER_STRING_ARRAY_COLUMNS = new Set(["alternateNames"]);

// ---------------------------------------------------------------------------
// Denied paths (server-derived / system-set — not borrower-entered fields)
// ---------------------------------------------------------------------------

function deniedPathReason(target: "borrower" | "shared", segs: PathSeg[]): string | null {
  for (const seg of segs) {
    if (seg.kind === "key" && seg.key === "id") {
      return "row ids are server-generated and cannot be corrected";
    }
  }
  const leaf = segs[segs.length - 1]!;
  if (leaf.kind === "key" && leaf.key === "accountNumberLast4") {
    return "accountNumberLast4 is derived — correct accountNumber instead";
  }
  const root = (segs[0] as { kind: "key"; key: string }).key;
  if (target === "shared" && root === "subjectProperty") {
    const second = segs[1];
    if (second && second.kind === "key" && second.key === "geocode") {
      return "geocode is computed server-side from the property address";
    }
  }
  if (
    target === "borrower" &&
    root === "demographics" &&
    leaf.kind === "key" &&
    (leaf.key === "collectionMethod" || leaf.key === "visualObservation")
  ) {
    return "demographic collection metadata is system-recorded (DATA-003)";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Correction domains → DTI/LTV relevance (§4.4.4) and related-check staleness
// (§4.6.5) — data-driven control dictionary.
// ---------------------------------------------------------------------------

type CorrectionDomain =
  | "income"
  | "liability"
  | "housing-expense"
  | "loan-amount"
  | "property-value"
  | "down-payment"
  | "loan-terms"
  | "property-other"
  | "identity"
  | "other";

/** The §4.4.4 / XBR-004 six: recalc is mandated and AUS goes stale post-run. */
const DTI_LTV_RELEVANT_DOMAINS: ReadonlySet<CorrectionDomain> = new Set([
  "income",
  "liability",
  "housing-expense",
  "loan-amount",
  "property-value",
  "down-payment",
]);

/**
 * XBR-025 (§4.6.5): a check goes stale when the corrected field feeds its
 * inputs or displayed results.
 *   - income and employment fields stale the income check;
 *   - ANY subject-property field — INCLUDING estimatedValue — stales the AVM
 *     check (subjectProperty.estimatedValue is the sole AVM input, see
 *     src/lib/pure/simulations/avm.ts). A stale AVM is not available to the
 *     LTV denominator (ASM-006), so this row is load-bearing for LTV.
 *   - pricing reads loan terms, LTV inputs (loan amount / value / down payment),
 *     occupancy/property type, and the PITI housing-expense components;
 *   - credit is a bureau pull keyed on borrower identity (name/SSN/DOB);
 *   - AUS consumes DTI/LTV/mid-score — every DTI/LTV-relevant domain
 *     (DTI_LTV_RELEVANT_DOMAINS above; minimum mandated by INV-030).
 * Corrections outside these domains (contact info, declarations, assets, ...)
 * change no check input and mark nothing stale.
 */
const CHECKS_AFFECTED_BY_DOMAIN: Record<CorrectionDomain, readonly CheckType[]> = {
  income: ["income", "aus"],
  liability: ["aus"],
  "housing-expense": ["pricing", "aus"],
  "loan-amount": ["pricing", "aus"],
  // XBR-025: estimatedValue is a subject-property field AND the sole AVM input.
  "property-value": ["avm", "pricing", "aus"],
  "down-payment": ["pricing", "aus"],
  "loan-terms": ["pricing"],
  "property-other": ["avm", "pricing"],
  identity: ["credit"],
  other: [],
};

const IDENTITY_FIELDS = new Set([
  "firstName",
  "middleName",
  "lastName",
  "suffix",
  "ssn",
  "dateOfBirth",
]);

const INCOME_ROOTS = new Set(["employments", "otherIncome", "employmentType"]);

function classifyDomain(target: "borrower" | "shared", segs: PathSeg[]): CorrectionDomain {
  const root = (segs[0] as { kind: "key"; key: string }).key;
  const leaf = segs[segs.length - 1]!;
  const leafKey = leaf.kind === "key" ? leaf.key : null;

  if (target === "borrower") {
    if (INCOME_ROOTS.has(root)) return "income";
    if (IDENTITY_FIELDS.has(root)) return "identity";
    return "other";
  }
  switch (root) {
    case "liabilities":
    case "otherLiabilities":
      return "liability";
    case "proposedHousingExpense":
      return "housing-expense";
    case "realEstateOwned":
      return leafKey === "netMonthlyRentalIncome" ? "income" : "other";
    case "loan":
      if (leafKey === "requestedLoanAmount") return "loan-amount";
      if (segs[1] && segs[1].kind === "key" && segs[1].key === "otherNewMortgages") {
        // otherNewMortgages amount/lienType feed CLTV (§E).
        return leafKey === "amount" || leafKey === "lienType" ? "loan-amount" : "loan-terms";
      }
      if (leafKey === "downPaymentAmount" || leafKey === "downPaymentSource") return "down-payment";
      return "loan-terms";
    case "subjectProperty":
      return leafKey === "estimatedValue" ? "property-value" : "property-other";
    default:
      return "other"; // assets / otherCredits
  }
}

// ---------------------------------------------------------------------------
// Zod walking + generic JSON path application
// ---------------------------------------------------------------------------

function unwrapSchema(s: z.ZodTypeAny): z.ZodTypeAny {
  let cur = s;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap();
    else if (cur instanceof z.ZodDefault) cur = cur._def.innerType;
    else if (cur instanceof z.ZodEffects) cur = cur._def.schema;
    else return cur;
  }
}

function validationProblem(details: string[]): HttpProblem {
  return new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
    details,
  });
}

/**
 * INV-039 / §A stale-stamp rejection — the same ErrorResponse the wizard's
 * section save returns, so the staff detail surface can drive the same
 * reload prompt.
 */
function staleStampConflict(): HttpProblem {
  return new HttpProblem(
    409,
    ERROR_CODES.conflict,
    "This application was changed in another tab or session — reload to continue editing",
  );
}

/** Resolve the leaf schema for a path; rejects unknown/non-scalar targets. */
function resolveLeafSchema(
  root: z.ZodTypeAny,
  segs: PathSeg[],
  fieldPath: string,
): z.ZodTypeAny {
  let cur: z.ZodTypeAny = root;
  for (const seg of segs) {
    const s = unwrapSchema(cur);
    if (seg.kind === "key") {
      if (!(s instanceof z.ZodObject)) {
        throw validationProblem([`fieldPath: "${seg.key}" cannot be reached in "${fieldPath}" — parent is not an object field`]);
      }
      const next = (s.shape as Record<string, z.ZodTypeAny>)[seg.key];
      if (!next) {
        throw validationProblem([`fieldPath: unknown field "${seg.key}" in "${fieldPath}"`]);
      }
      cur = next;
    } else {
      if (!(s instanceof z.ZodArray)) {
        throw validationProblem([`fieldPath: index [${seg.index}] in "${fieldPath}" does not address an array field`]);
      }
      cur = s.element;
    }
  }
  const leaf = unwrapSchema(cur);
  if (leaf instanceof z.ZodObject || leaf instanceof z.ZodArray || leaf instanceof z.ZodRecord || leaf instanceof z.ZodTuple) {
    throw validationProblem([
      `fieldPath: "${fieldPath}" addresses a ${leaf instanceof z.ZodArray ? "list" : "group"} — corrections target one scalar field (VR-091)`,
    ]);
  }
  return cur; // wrapper retained: isOptional/isNullable decide clearability
}

/** Sentinel for "clear this field" (newValue: "null" on an optional field). */
const CLEAR: unique symbol = Symbol("clear-field");

interface ApplyResult {
  updated: unknown;
  before: unknown;
}

/**
 * Immutably set/clear the value at `segs` inside `node`. Missing OBJECT
 * containers along the path are auto-created (schema-directed); arrays and
 * array elements must already exist — a correction edits recorded rows, it
 * does not append them.
 */
function applyAtPath(
  node: unknown,
  schema: z.ZodTypeAny,
  segs: PathSeg[],
  value: unknown,
  fieldPath: string,
): ApplyResult {
  if (segs.length === 0) {
    return { updated: value === CLEAR ? undefined : value, before: node };
  }
  const [seg, ...rest] = segs;
  const s = unwrapSchema(schema);

  if (seg.kind === "key") {
    if (!(s instanceof z.ZodObject)) {
      throw validationProblem([`fieldPath: "${fieldPath}" traverses a non-object value`]);
    }
    let base: Record<string, unknown>;
    if (node === undefined || node === null) {
      base = {}; // auto-create missing object container
    } else if (typeof node === "object" && !Array.isArray(node)) {
      base = node as Record<string, unknown>;
    } else {
      throw validationProblem([`fieldPath: stored value at "${seg.key}" in "${fieldPath}" is not an object`]);
    }
    const childSchema = (s.shape as Record<string, z.ZodTypeAny>)[seg.key]!;
    const child = applyAtPath(base[seg.key], childSchema, rest, value, fieldPath);
    const updated: Record<string, unknown> = { ...base };
    if (child.updated === undefined) delete updated[seg.key];
    else updated[seg.key] = child.updated;
    return { updated, before: child.before };
  }

  if (!(s instanceof z.ZodArray)) {
    throw validationProblem([`fieldPath: "${fieldPath}" indexes into a non-list value`]);
  }
  if (!Array.isArray(node)) {
    throw validationProblem([`fieldPath: no list exists at index [${seg.index}] in "${fieldPath}"`]);
  }
  if (seg.index >= node.length) {
    throw validationProblem([
      `fieldPath: no element at index [${seg.index}] in "${fieldPath}" (${node.length} recorded)`,
    ]);
  }
  const child = applyAtPath(node[seg.index], s.element, rest, value, fieldPath);
  if (child.updated === undefined) {
    throw validationProblem([`fieldPath: a list element in "${fieldPath}" cannot be cleared by a correction`]);
  }
  const updated = [...node];
  updated[seg.index] = child.updated;
  return { updated, before: child.before };
}

/** Tolerant read of the value at `segs` (undefined when absent). */
function getAtPath(node: unknown, segs: PathSeg[]): unknown {
  let cur: unknown = node;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (seg.kind === "key") {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg.key];
    } else {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
    }
  }
  return cur;
}

function accountLast4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  return (digits.length >= 4 ? digits : accountNumber).slice(-4);
}

function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/** Decimal → number for display/audit (Prisma Decimal columns). */
function plainValue(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return Number(value);
  return value;
}

function shortDisplay(value: unknown): string {
  const s = JSON.stringify(value ?? null);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

// ---------------------------------------------------------------------------
// Audit-envelope projection (the stored correction record)
// ---------------------------------------------------------------------------

interface CorrectionEnvelope {
  fieldPath: string;
  borrowerOrdinal?: number;
  value: unknown;
  /** XBR-018 provenance seam for the increment-8 apply-suggestion caller. */
  sourceDocumentId?: string;
}

function readEnvelope(value: Prisma.JsonValue | null): CorrectionEnvelope | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.fieldPath !== "string") return null;
  return {
    fieldPath: rec.fieldPath,
    borrowerOrdinal: typeof rec.borrowerOrdinal === "number" ? rec.borrowerOrdinal : undefined,
    value: rec.value,
    sourceDocumentId: typeof rec.sourceDocumentId === "string" ? rec.sourceDocumentId : undefined,
  };
}

type CorrectionAuditRow = {
  id: string;
  applicationId: string | null;
  timestamp: Date;
  actorRole: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
  actorUser: { firstName: string; lastName: string } | null;
};

function toCorrectionInfo(row: CorrectionAuditRow): CorrectionInfo {
  const after = readEnvelope(row.after);
  const before = readEnvelope(row.before);
  const info: CorrectionInfo = {
    id: row.id,
    applicationId: row.applicationId ?? "",
    fieldPath: after?.fieldPath ?? "",
    afterValue: JSON.stringify(after ? after.value ?? null : null),
    correctedByName: row.actorUser
      ? `${row.actorUser.firstName} ${row.actorUser.lastName}`.trim()
      : "Former staff user",
    correctedByRole: row.actorRole ?? "",
    correctedAt: row.timestamp.toISOString(),
    reason: row.reason ?? "",
  };
  if (after?.borrowerOrdinal !== undefined) info.borrowerOrdinal = after.borrowerOrdinal;
  if (before !== null) info.beforeValue = JSON.stringify(before.value ?? null);
  return info;
}

// ---------------------------------------------------------------------------
// recordCorrection — the single write path (also the increment-8
// apply-suggestion seam: pass sourceDocumentId for XBR-018 provenance)
// ---------------------------------------------------------------------------

export interface RecordCorrectionInput extends CorrectionRequest {
  sourceDocumentId?: string;
}

export async function recordCorrection(
  user: SessionUser,
  applicationId: string,
  input: RecordCorrectionInput,
  meta: RequestMetaBundle,
): Promise<CorrectionInfo> {
  // SEC-6 / S-3 / S-4 record-level scoping: active assignment or Supervisor.
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

  // --- fieldPath grammar + target resolution --------------------------------
  const segs = parseFieldPath(input.fieldPath);
  if (!segs) {
    throw validationProblem([
      `fieldPath: "${input.fieldPath}" is not a valid dot/bracket path (e.g. "loan.requestedLoanAmount", "employments[0].baseMonthlyIncome")`,
    ]);
  }
  const root = (segs[0] as { kind: "key"; key: string }).key;

  let target: "borrower" | "shared";
  if (BORROWER_ROOTS.has(root)) {
    target = "borrower";
    if (input.borrowerOrdinal === undefined) {
      throw validationProblem([
        `borrowerOrdinal: required for the borrower field path "${input.fieldPath}" (VR-090)`,
      ]);
    }
  } else if (SHARED_ROOTS.has(root)) {
    target = "shared";
    if (input.borrowerOrdinal !== undefined) {
      throw validationProblem([
        `borrowerOrdinal: "${input.fieldPath}" is a shared-section path — borrowerOrdinal does not apply`,
      ]);
    }
  } else {
    throw validationProblem([`fieldPath: unknown field "${root}"`]);
  }

  const denied = deniedPathReason(target, segs);
  if (denied) throw validationProblem([`fieldPath: ${denied}`]);

  // --- newValue: JSON-encoded scalar validated against the field schema -----
  const rootSchema = target === "borrower" ? borrowerRootSchema : sharedRootSchema;
  const leafSchema = resolveLeafSchema(rootSchema, segs, input.fieldPath);

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(input.newValue);
  } catch {
    throw validationProblem(["newValue: must be a JSON-encoded scalar (VR-091)"]);
  }
  if (parsedValue !== null && !["string", "number", "boolean"].includes(typeof parsedValue)) {
    throw validationProblem(["newValue: must be a JSON-encoded scalar, not an object or array (VR-091)"]);
  }

  const leaf = segs[segs.length - 1]!;
  const leafKey = leaf.kind === "key" ? leaf.key : null;
  const isSecretLeaf =
    (target === "borrower" && (root === "ssn" || root === "dateOfBirth")) ||
    (target === "shared" && leafKey === "accountNumber");

  let valueToApply: unknown | typeof CLEAR;
  if (parsedValue === null) {
    if (isSecretLeaf) {
      throw validationProblem([`fieldPath: "${input.fieldPath}" cannot be cleared by a correction`]);
    }
    if (!leafSchema.isOptional() && !leafSchema.isNullable()) {
      throw validationProblem([
        `newValue: "${input.fieldPath}" is required and cannot be cleared`,
      ]);
    }
    valueToApply = CLEAR;
  } else {
    const checked = unwrapSchema(leafSchema).safeParse(parsedValue);
    if (!checked.success) {
      throw validationProblem(
        checked.error.issues.map((issue) => `${input.fieldPath}: ${issue.message}`),
      );
    }
    valueToApply = checked.data;
  }

  const domain = classifyDomain(target, segs);
  const affectedChecks = CHECKS_AFFECTED_BY_DOMAIN[domain];

  const result = await prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: { id: true, applicationNumber: true, workflowState: true, versionStamp: true },
    });
    if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

    // §4.4.4 / SEC-6: the five staff-editable states only — 409 otherwise.
    if (!(STAFF_EDITABLE_STATES as readonly string[]).includes(app.workflowState)) {
      throw new HttpProblem(
        409,
        ERROR_CODES.conflict,
        "Corrections are not permitted in the application's current state",
        { currentState: app.workflowState },
      );
    }

    // INV-039: early stamp check for a clean 409 before any write; the
    // versionStamp WHERE clause on the conditional update below decides
    // genuine races (identical posture to approval.ts / application-data.ts).
    if (app.versionStamp !== input.versionStamp) throw staleStampConflict();

    let entityType: string;
    let entityId: string;
    let beforeDisplay: unknown; // masked for secrets; undefined = no prior value
    let afterDisplay: unknown;

    if (target === "borrower") {
      const ordinal = input.borrowerOrdinal!;
      const borrower = await tx.borrower.findUnique({
        where: { applicationId_ordinal: { applicationId, ordinal } },
      });
      if (!borrower) {
        throw new HttpProblem(
          404,
          ERROR_CODES.notFound,
          `Borrower ${ordinal} not found on this application`,
        );
      }
      entityType = "Borrower";
      entityId = borrower.id;

      const update: Prisma.BorrowerUncheckedUpdateInput = {};

      if (root === "ssn") {
        // VR-069 already validated; re-seal + last4 + blind index (task-002).
        const ssn = valueToApply as string;
        const sealed = encryptField(ssn);
        update.ssnCiphertext = new Uint8Array(sealed.ciphertext);
        update.ssnKeyId = sealed.keyId;
        update.ssnLast4 = ssnLast4(ssn);
        update.ssnBlindIndex = ssnBlindIndex(ssn);
        beforeDisplay = borrower.ssnLast4 ? `***-**-${borrower.ssnLast4}` : undefined;
        afterDisplay = `***-**-${ssnLast4(ssn)}`;
      } else if (root === "dateOfBirth") {
        const dob = valueToApply as string;
        const sealed = encryptField(dob);
        update.dateOfBirthCiphertext = new Uint8Array(sealed.ciphertext);
        update.dateOfBirthKeyId = sealed.keyId;
        // SEC-2 / NFR-003: raw ISO DOB never leaves the identity-own endpoint,
        // so the audit/CorrectionInfo record carries the SAME display form the
        // serializer emits (dateOfBirthDisplay) — THE masking module.
        const priorDob =
          borrower.dateOfBirthCiphertext && borrower.dateOfBirthKeyId
            ? decryptField({
                ciphertext: new Uint8Array(borrower.dateOfBirthCiphertext),
                keyId: borrower.dateOfBirthKeyId,
              })
            : undefined;
        beforeDisplay = priorDob === undefined ? undefined : formatDobDisplay(priorDob);
        afterDisplay = formatDobDisplay(dob);
      } else if (BORROWER_JSON_COLUMNS.has(root) || BORROWER_STRING_ARRAY_COLUMNS.has(root)) {
        const column = root as keyof typeof borrower;
        const applied = applyAtPath(
          borrower[column],
          (borrowerRootSchema.shape as Record<string, z.ZodTypeAny>)[root]!,
          segs.slice(1),
          valueToApply,
          input.fieldPath,
        );
        if (BORROWER_STRING_ARRAY_COLUMNS.has(root)) {
          (update as Record<string, unknown>)[root] = applied.updated as string[];
        } else {
          (update as Record<string, unknown>)[root] = jsonColumn(applied.updated);
        }
        beforeDisplay = applied.before;
        afterDisplay = valueToApply === CLEAR ? null : valueToApply;
      } else {
        // Scalar column (schema resolution guarantees segs = [root]).
        (update as Record<string, unknown>)[root] =
          valueToApply === CLEAR ? null : valueToApply;
        beforeDisplay = plainValue(borrower[root as keyof typeof borrower]);
        afterDisplay = valueToApply === CLEAR ? null : valueToApply;
      }

      await tx.borrower.update({ where: { id: borrower.id }, data: update });
    } else {
      const data = await tx.applicationData.findUnique({ where: { applicationId } });
      entityType = "ApplicationData";

      const columnValue = data ? (data as Record<string, unknown>)[root] : undefined;
      const applied = applyAtPath(
        columnValue,
        (sharedRootSchema.shape as Record<string, z.ZodTypeAny>)[root]!,
        segs.slice(1),
        leafKey === "accountNumber"
          ? (encryptFieldToJson(valueToApply as string) as unknown)
          : valueToApply,
        input.fieldPath,
      );
      let updatedColumn = applied.updated;
      beforeDisplay = applied.before;
      afterDisplay = valueToApply === CLEAR ? null : valueToApply;

      if (leafKey === "accountNumber") {
        // Sealed envelope written above; refresh the sibling last4 and mask
        // both sides for the record (S-5 posture — no plaintext numbers).
        const last4 = accountLast4(valueToApply as string);
        const siblingSegs = [...segs.slice(1, -1), { kind: "key", key: "accountNumberLast4" } as PathSeg];
        const priorLast4 = getAtPath(columnValue, siblingSegs);
        updatedColumn = applyAtPath(
          updatedColumn,
          (sharedRootSchema.shape as Record<string, z.ZodTypeAny>)[root]!,
          siblingSegs,
          last4,
          input.fieldPath,
        ).updated;
        beforeDisplay = typeof priorLast4 === "string" ? `****${priorLast4}` : undefined;
        afterDisplay = `****${last4}`;
      }

      if (root === "subjectProperty") {
        // LIVE-STATE: the persisted geocode is always re-derived from the
        // (possibly corrected) address — same hook as the wizard save.
        updatedColumn = withServerGeocode(
          updatedColumn as { address?: unknown; geocode?: unknown } | undefined,
        );
      }

      const columnUpdate = { [root]: jsonColumn(updatedColumn) };
      const updatedData = await tx.applicationData.upsert({
        where: { applicationId },
        create: { applicationId, ...columnUpdate } as Prisma.ApplicationDataUncheckedCreateInput,
        update: columnUpdate,
      });
      entityId = updatedData.id;
    }

    // XBR-003 posture: signature validity is DERIVED from the data hash — any
    // application-data edit re-evaluates it in the same transaction.
    await invalidateSignaturesOnDataChange(tx, applicationId);

    // NFR-008 / AC-13: THE shared qualification module, in-tx, persisted like
    // the wizard-save path. Deterministic no-op for non-relevant fields.
    const qualification = await computeApplicationQualification(applicationId, tx);

    // INV-039: the conditional update IS the race guard — versionStamp in the
    // WHERE clause; a concurrent committed write makes count 0 → 409 and the
    // whole transaction (data edit + audit entry) rolls back. Never a silent
    // overwrite, and never a lost update disguised as a sequential edit.
    const updatedCount = await tx.application.updateMany({
      where: { id: applicationId, versionStamp: input.versionStamp },
      data: {
        versionStamp: { increment: 1 },
        dti: qualification.dti,
        ltv: qualification.ltv,
        cltv: qualification.cltv,
      },
    });
    if (updatedCount.count === 0) throw staleStampConflict();

    // §4.6.5 / XBR-004 / INV-030: related results stale; AUS staleness
    // mirrored on the application (blocks T15 in the workflow engine).
    await markChecksStale(tx, applicationId, affectedChecks);

    // The correction IS this audit entry (storage decision, module header).
    const normalizedBefore = plainValue(beforeDisplay);
    const beforeEnvelope: CorrectionEnvelope | undefined =
      normalizedBefore === undefined
        ? undefined
        : {
            fieldPath: input.fieldPath,
            ...(input.borrowerOrdinal !== undefined ? { borrowerOrdinal: input.borrowerOrdinal } : {}),
            value: normalizedBefore,
          };
    const afterEnvelope: CorrectionEnvelope = {
      fieldPath: input.fieldPath,
      ...(input.borrowerOrdinal !== undefined ? { borrowerOrdinal: input.borrowerOrdinal } : {}),
      value: afterDisplay ?? null,
      ...(input.sourceDocumentId !== undefined ? { sourceDocumentId: input.sourceDocumentId } : {}),
    };

    const auditRow = await audit(tx, {
      actor: user.userId, // session identity only — never from the body
      role: user.role,
      actionType: "correction",
      applicationId,
      entityType,
      entityId,
      summary: `Correction to ${input.fieldPath}${
        input.borrowerOrdinal !== undefined ? ` (borrower ${input.borrowerOrdinal})` : ""
      } on application ${app.applicationNumber}: ${shortDisplay(normalizedBefore)} -> ${shortDisplay(afterDisplay)}`,
      before: beforeEnvelope as unknown as Prisma.InputJsonValue | undefined,
      after: afterEnvelope as unknown as Prisma.InputJsonValue,
      reason: input.reason,
      ip: meta.ip,
      requestId: meta.requestId,
    });

    return auditRow;
  });

  return toCorrectionInfo({
    id: result.id,
    applicationId: result.applicationId,
    timestamp: result.timestamp,
    actorRole: result.actorRole,
    before: result.before,
    after: result.after,
    reason: result.reason,
    actorUser: { firstName: user.firstName, lastName: user.lastName },
  });
}

// ---------------------------------------------------------------------------
// listCorrections — CorrectionPage projection of the correction audit rows
// ---------------------------------------------------------------------------

export async function listCorrections(
  applicationId: string,
  pagination: Pagination,
): Promise<PageEnvelope<CorrectionInfo>> {
  const where = { applicationId, actionType: "correction" as const };
  const [rows, total] = await Promise.all([
    prisma.auditLogEntry.findMany({
      where,
      orderBy: [{ timestamp: "desc" }, { createdAt: "desc" }],
      skip: pagination.skip,
      take: pagination.take,
      include: { actorUser: { select: { firstName: true, lastName: true } } },
    }),
    prisma.auditLogEntry.count({ where }),
  ]);
  return pageEnvelope(rows.map((row) => toCorrectionInfo(row)), pagination, total);
}
