// Document service (task-013): upload, checklist, replacement/versioning,
// magic-byte sniffing, downloads, deletion, status changes, document requests.
//
// REQ-038, REQ-053, NFR-012/013, INT-012, SEC-12/13, XBR-006/016/024,
// VR-095..VR-100, INV-007/021/024/026, ASYNC-001, ASM-004.
//
// Route handlers stay thin: they guard, parse, call these functions, and map
// HttpProblem to the single ErrorResponse shape.
//
// INV-007 / SEC-13 ordering (upload + replacement):
//   1. permission + limit + sniff checks,
//   2. storage object written FIRST (an orphan object is recoverable garbage;
//      a dangling DB row is not),
//   3. ONE transaction creates Document + DocumentVersion + repoints
//      currentVersionId + creates the queued DocumentJob (job row exists
//      BEFORE the upload response returns) + fulfills any open DocumentRequest
//      (XBR-024) + audits,
//   4. on transaction failure the orphan object is deleted.
// Deletion is the reverse: rows first (in-tx, audited), then objects — a
// failed object delete never resurrects rows (logged and skipped; reconciler
// territory, task-034's boot pass).
//
// ASYNC DISPATCH (ASYNC-001): this module only CREATES the queued DocumentJob
// row — the OCR worker is task-034 (increment 8). Jobs are never faked to
// completion here.

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canReadApplication, canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import { getNumberSetting } from "@/lib/services/config";
import { handOffOcrJobExecution } from "@/lib/services/document-ocr";
import { getStorage, newStorageKey } from "@/lib/services/storage";
import { sniffContentType, sanitizeDownloadFileName } from "@/lib/pure/file-sniff";
import {
  evaluateChecklist,
  checklistOrderIndex,
  matchChecklistItemKey,
  type ChecklistInput,
  type ChecklistItem,
} from "@/lib/pure/checklist";
import {
  DOCUMENT_TYPE_LABELS,
  type DocumentStatusRequest,
  type DocumentTypeValue,
  type DocumentUploadRequest,
  type DocumentRequestCreate,
} from "@/lib/schemas/document";

type Db = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Constants & problems
// ---------------------------------------------------------------------------

/** §B list endpoints for documents/document-requests: no pagination params, max 50. */
const LIST_MAX = 50;

/** ASM-004: borrower uploads freely in these states. */
const BORROWER_FREE_UPLOAD_STATES: readonly WorkflowState[] = ["draft", "revision_requested"];

/**
 * ASM-004: in every other pre-decision state (2–7) AND Conditional Approval the
 * borrower may upload only against an open DocumentRequest of that type.
 */
const BORROWER_REQUEST_GATED_STATES: readonly WorkflowState[] = [
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
];

function notFoundProblem(message = "Not found"): HttpProblem {
  return new HttpProblem(404, ERROR_CODES.notFound, message);
}

function forbiddenProblem(message = "You do not have permission to perform this action"): HttpProblem {
  return new HttpProblem(403, ERROR_CODES.forbidden, message);
}

/**
 * Map a write-scoping denial. Borrowers get 404 for records they do not own
 * (no existence disclosure — task-011 throwBorrowerActionDenial convention);
 * unassigned staff get 403.
 */
function throwScopeDenial(reason: "not-found" | "not-owner" | "not-assigned"): never {
  if (reason === "not-assigned") {
    throw forbiddenProblem("You are not assigned to this application");
  }
  throw notFoundProblem("Application not found");
}

// ---------------------------------------------------------------------------
// Wire shapes (contracts.md §A — exact field names)
// ---------------------------------------------------------------------------

export interface DocumentVersionInfoWire {
  id: string;
  versionNumber: number;
  originalFileName: string;
  sniffedContentType: string;
  sizeBytes: number;
  sha256?: string;
  uploadedByName?: string;
  createdAt: string;
}

export interface DocumentWire {
  id: string;
  applicationId: string;
  documentType: string;
  description?: string;
  checklistItemKey?: string;
  status: string;
  statusReason?: string;
  currentVersionId: string;
  currentVersionNumber: number;
  jobStatus?: string;
  versions?: DocumentVersionInfoWire[];
  uploadedByName?: string;
  isSeed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentListResponseWire {
  checklist: ChecklistItem[];
  documents: DocumentWire[];
}

export interface DocumentRequestInfoWire {
  id: string;
  applicationId: string;
  documentType: string;
  reason: string;
  requestedByName?: string;
  fulfilledByDocumentId?: string;
  createdAt: string;
}

export interface DocumentRequestListWire {
  rows: DocumentRequestInfoWire[];
}

// ---------------------------------------------------------------------------
// Loading & serialization
// ---------------------------------------------------------------------------

const DOCUMENT_INCLUDE = {
  uploadedByUser: { select: { firstName: true, lastName: true } },
  versions: {
    orderBy: { versionNumber: "asc" as const },
    include: {
      uploadedByUser: { select: { firstName: true, lastName: true } },
      jobs: { orderBy: { createdAt: "desc" as const }, take: 1, select: { status: true } },
    },
  },
} satisfies Prisma.DocumentInclude;

type DocumentWithRelations = Prisma.DocumentGetPayload<{ include: typeof DOCUMENT_INCLUDE }>;

function personName(person: { firstName: string; lastName: string } | null | undefined): string | undefined {
  if (!person) return undefined;
  const name = `${person.firstName} ${person.lastName}`.trim();
  return name.length > 0 ? name : undefined;
}

export function toDocumentWire(row: DocumentWithRelations): DocumentWire {
  // INV-007: the service never commits a Document without a current version.
  const current = row.versions.find((v) => v.id === row.currentVersionId);
  if (!row.currentVersionId || !current) {
    throw new Error(`Document ${row.id} violates INV-007 (dangling currentVersionId)`);
  }
  const jobStatus = current.jobs[0]?.status;

  const wire: DocumentWire = {
    id: row.id,
    applicationId: row.applicationId,
    documentType: row.documentType,
    status: row.status,
    currentVersionId: row.currentVersionId,
    currentVersionNumber: current.versionNumber,
    versions: row.versions.map((v) => {
      const info: DocumentVersionInfoWire = {
        id: v.id,
        versionNumber: v.versionNumber,
        originalFileName: v.originalFileName,
        sniffedContentType: v.sniffedContentType,
        sizeBytes: v.sizeBytes,
        createdAt: v.createdAt.toISOString(),
      };
      if (v.sha256) info.sha256 = v.sha256;
      const uploader = personName(v.uploadedByUser);
      if (uploader) info.uploadedByName = uploader;
      return info;
    }),
    isSeed: row.isSeed,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.description != null) wire.description = row.description;
  if (row.checklistItemKey != null) wire.checklistItemKey = row.checklistItemKey;
  if (row.statusReason != null) wire.statusReason = row.statusReason;
  if (jobStatus) wire.jobStatus = jobStatus;
  const uploadedByName = personName(row.uploadedByUser);
  if (uploadedByName) wire.uploadedByName = uploadedByName;
  return wire;
}

function toDocumentRequestWire(
  row: Prisma.DocumentRequestGetPayload<{
    include: { requestedByUser: { select: { firstName: true; lastName: true } } };
  }>,
): DocumentRequestInfoWire {
  const wire: DocumentRequestInfoWire = {
    id: row.id,
    applicationId: row.applicationId,
    documentType: row.documentType,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
  const requester = personName(row.requestedByUser);
  if (requester) wire.requestedByName = requester;
  if (row.fulfilledByDocumentId != null) wire.fulfilledByDocumentId = row.fulfilledByDocumentId;
  return wire;
}

async function loadDocumentWire(db: Db, documentId: string): Promise<DocumentWire> {
  const row = await db.document.findUnique({ where: { id: documentId }, include: DOCUMENT_INCLUDE });
  if (!row) throw notFoundProblem("Document not found");
  return toDocumentWire(row);
}

// ---------------------------------------------------------------------------
// Checklist input (live application data — LIVE-STATE BUILDER RULE)
// ---------------------------------------------------------------------------

interface ChecklistDocRow {
  id: string;
  documentType: string;
  description: string | null;
  status: string;
  checklistItemKey: string | null;
  createdAt: Date;
}

async function buildChecklistInput(
  db: Db,
  applicationId: string,
  documents: readonly ChecklistDocRow[],
): Promise<ChecklistInput> {
  const [borrowers, data] = await Promise.all([
    db.borrower.findMany({
      where: { applicationId },
      orderBy: { ordinal: "asc" },
      select: {
        ordinal: true,
        firstName: true,
        lastName: true,
        employmentType: true,
        employments: true,
      },
      take: 2,
    }),
    db.applicationData.findUnique({
      where: { applicationId },
      select: { loan: true, otherCredits: true },
    }),
  ]);

  const loan = (data?.loan ?? {}) as {
    loanType?: string;
    loanPurpose?: string;
    downPaymentSource?: string;
  };
  const otherCredits = Array.isArray(data?.otherCredits)
    ? (data.otherCredits as { type?: string }[])
    : [];

  return {
    loanType: loan.loanType ?? null,
    loanPurpose: loan.loanPurpose ?? null,
    downPaymentSource: loan.downPaymentSource ?? null,
    otherCreditTypes: otherCredits
      .map((c) => c.type)
      .filter((t): t is string => typeof t === "string"),
    borrowers: borrowers.map((b) => ({
      ordinal: b.ordinal,
      firstName: b.firstName,
      lastName: b.lastName,
      employmentType: b.employmentType,
      employments: Array.isArray(b.employments)
        ? (b.employments as { selfEmployed?: boolean }[])
        : [],
    })),
    documents: documents.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      description: d.description,
      status: d.status,
      checklistItemKey: d.checklistItemKey,
      createdAt: d.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Upload permission matrix (ASM-004)
// ---------------------------------------------------------------------------

interface UploadPermission {
  /** The open, unfulfilled DocumentRequest satisfying the gate, when one gated the upload. */
  openRequestRequired: boolean;
}

/**
 * ASM-004 state matrix, applied AFTER write scoping (canWriteApplication):
 *   BORROWER   — free upload in Draft / Revision Requested; in pre-decision
 *                states 2–7 + Conditional Approval only against an open
 *                DocumentRequest of the uploaded type (checked in-transaction);
 *                any other state → 409 (workflow-state conflict — chosen over
 *                403 because the ROLE and OWNERSHIP are valid; the application
 *                STATE forbids the action, matching the build's 409 semantics).
 *   STAFF      — unrestricted on assigned applications (caseworker assignment
 *                already proven by canWriteApplication; supervisor S-4).
 */
function assertUploadStatePermitted(
  user: SessionUser,
  workflowState: WorkflowState,
): UploadPermission {
  if (user.role !== "BORROWER") return { openRequestRequired: false };
  if (BORROWER_FREE_UPLOAD_STATES.includes(workflowState)) return { openRequestRequired: false };
  if (BORROWER_REQUEST_GATED_STATES.includes(workflowState)) return { openRequestRequired: true };
  throw new HttpProblem(
    409,
    ERROR_CODES.conflict,
    `Documents cannot be uploaded while the application is in the ${workflowState} state`,
  );
}

/** Oldest open (unfulfilled) DocumentRequest of the given type, or null. */
async function findOpenRequest(
  db: Db,
  applicationId: string,
  documentType: string,
): Promise<{ id: string } | null> {
  return db.documentRequest.findFirst({
    where: { applicationId, documentType, fulfilledByDocumentId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Validated file payload (size + sniff, INV-024 / SEC-12)
// ---------------------------------------------------------------------------

export interface UploadedFile {
  originalFileName: string;
  bytes: Buffer;
}

interface CheckedFile {
  originalFileName: string;
  bytes: Buffer;
  sniffedContentType: string;
  sizeBytes: number;
  sha256: string;
}

/** Enforce the CONFIGURED size limit (413) and magic-byte sniff (400). */
async function checkFile(file: UploadedFile): Promise<CheckedFile> {
  const maxMb = await getNumberSetting("documents.maxFileSizeMb");
  const maxBytes = Math.floor(maxMb * 1024 * 1024);
  if (file.bytes.length > maxBytes) {
    throw new HttpProblem(
      413,
      "file_too_large",
      `File exceeds the configured maximum size of ${maxMb} MB`,
    );
  }
  if (file.bytes.length === 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: ["file: uploaded file is empty"],
    });
  }
  const sniff = sniffContentType(file.bytes);
  if (!sniff) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: [
        "file: content is not an accepted type — PDF, JPEG, or PNG required (content sniffed; the file name and client MIME type are not trusted)",
      ],
    });
  }
  return {
    originalFileName: file.originalFileName.trim().slice(0, 255) || "document",
    bytes: file.bytes,
    sniffedContentType: sniff.contentType,
    sizeBytes: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// POST /api/applications/:id/documents — upload (201 Document)
// ---------------------------------------------------------------------------

export async function uploadDocument(
  user: SessionUser,
  applicationId: string,
  body: DocumentUploadRequest,
  file: UploadedFile,
  meta: RequestMetaBundle,
): Promise<DocumentWire> {
  const access = await canWriteApplication(user, applicationId);
  if (!access.allowed) throwScopeDenial(access.reason);
  const permission = assertUploadStatePermitted(user, access.application.workflowState);

  const checked = await checkFile(file);
  const maxDocs = await getNumberSetting("documents.maxPerApplication");

  // SEC-12 / INV-007 ordering: object first, records in one tx, orphan cleanup on failure.
  const storageKey = newStorageKey(applicationId);
  await getStorage().put(storageKey, checked.bytes);

  let documentId: string;
  // task-034 (ASYNC-001): id of the queued DocumentJob created in-transaction —
  // its execution is handed off only AFTER the transaction commits.
  let createdJobId: string | null = null;
  try {
    documentId = await prisma.$transaction(async (tx) => {
      // INV-024: configured per-application document cap, check-then-act in-tx.
      const count = await tx.document.count({ where: { applicationId } });
      if (count >= maxDocs) {
        throw new HttpProblem(
          409,
          ERROR_CODES.conflict,
          `This application already has the maximum of ${maxDocs} documents`,
        );
      }

      // ASM-004 gate re-checked in-tx so fulfillment is race-consistent.
      const openRequest = await findOpenRequest(tx, applicationId, body.documentType);
      if (permission.openRequestRequired && !openRequest) {
        throw new HttpProblem(
          409,
          ERROR_CODES.conflict,
          "Uploads in the current application state require an open document request of this type",
        );
      }

      // Live checklist binding for the new document (checklistItemKey or absent).
      const existingDocs = await tx.document.findMany({
        where: { applicationId },
        select: {
          id: true,
          documentType: true,
          description: true,
          status: true,
          checklistItemKey: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
        take: LIST_MAX,
      });
      const checklistInput = await buildChecklistInput(tx, applicationId, existingDocs);
      const checklistItemKey = matchChecklistItemKey(
        checklistInput,
        body.documentType,
        body.description ?? null,
      );

      const doc = await tx.document.create({
        data: {
          applicationId,
          documentType: body.documentType,
          description: body.description ?? null,
          checklistItemKey: checklistItemKey ?? null,
          status: "pending",
          uploadedByUserId: user.userId,
        },
      });
      const version = await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNumber: 1,
          storageKey,
          originalFileName: checked.originalFileName,
          sniffedContentType: checked.sniffedContentType,
          sizeBytes: checked.sizeBytes,
          sha256: checked.sha256,
          uploadedByUserId: user.userId,
        },
      });
      await tx.document.update({
        where: { id: doc.id },
        data: { currentVersionId: version.id },
      });

      // SEC-13 / XBR-016 / ASYNC-001: the queued DocumentJob row exists before
      // the response returns. Execution handoff happens AFTER this transaction
      // commits (task-034 worker) — never faked here.
      const job = await tx.documentJob.create({
        data: {
          documentVersionId: version.id,
          status: "queued",
          attempt: 0,
          maxAttempts: await getNumberSetting("ocr.retryLimit"),
        },
      });
      createdJobId = job.id;

      // XBR-024: a matching open request is fulfilled by this document.
      if (openRequest) {
        await tx.documentRequest.update({
          where: { id: openRequest.id },
          data: { fulfilledByDocumentId: doc.id },
        });
      }

      await audit(tx as AuditTransactionClient, {
        actor: user.userId,
        role: user.role,
        actionType: "document-upload",
        applicationId,
        entityType: "Document",
        entityId: doc.id,
        summary: `Uploaded ${DOCUMENT_TYPE_LABELS[body.documentType as DocumentTypeValue] ?? body.documentType} "${checked.originalFileName}" (version 1${openRequest ? ", fulfilling an open document request" : ""})`,
        ip: meta.ip,
        requestId: meta.requestId,
      });

      // §4.8.2 caseworker trigger "document uploaded/replaced by borrower" —
      // via THE notification service (task-036), in-tx, to the active assignee.
      if (user.role === "BORROWER" && access.application.activeAssignmentCaseworkerId) {
        await createNotification(tx, {
          recipientUserId: access.application.activeAssignmentCaseworkerId,
          type: "document-uploaded",
          title: "Document uploaded",
          body: `The borrower uploaded ${DOCUMENT_TYPE_LABELS[body.documentType as DocumentTypeValue] ?? body.documentType} "${checked.originalFileName}".`,
          applicationId,
        });
      }

      return doc.id;
    });
  } catch (err) {
    // Roll the orphan object back — records did not commit.
    await getStorage()
      .delete(storageKey)
      .catch(() => undefined);
    throw err;
  }

  // task-034 execution handoff (ASYNC-001): the transaction committed with the
  // queued job row — start the worker chain via Next `after()` (detached
  // promise outside a request scope) so the response returns first.
  if (createdJobId) handOffOcrJobExecution(createdJobId);

  return loadDocumentWire(prisma, documentId);
}

// ---------------------------------------------------------------------------
// POST /api/documents/:id/versions — replacement (201 Document)
// ---------------------------------------------------------------------------

export async function uploadDocumentVersion(
  user: SessionUser,
  documentId: string,
  body: DocumentUploadRequest,
  file: UploadedFile,
  meta: RequestMetaBundle,
): Promise<DocumentWire> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, applicationId: true, documentType: true, description: true },
  });
  if (!doc) throw notFoundProblem("Document not found");

  const access = await canWriteApplication(user, doc.applicationId);
  if (!access.allowed) throwScopeDenial(access.reason);
  const permission = assertUploadStatePermitted(user, access.application.workflowState);

  // VR-095/096 apply to the replacement body; the documentType must match the
  // document being replaced — a replacement never changes a document's type.
  if (body.documentType !== doc.documentType) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: [
        `documentType: a replacement must keep the document's type (${doc.documentType})`,
      ],
    });
  }

  const checked = await checkFile(file);
  const storageKey = newStorageKey(doc.applicationId);
  await getStorage().put(storageKey, checked.bytes);

  // task-034 (ASYNC-001): queued-job id captured in-tx, handed off post-commit.
  let createdJobId: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const openRequest = await findOpenRequest(tx, doc.applicationId, doc.documentType);
      if (permission.openRequestRequired && !openRequest) {
        throw new HttpProblem(
          409,
          ERROR_CODES.conflict,
          "Uploads in the current application state require an open document request of this type",
        );
      }

      // Race-safe version numbering: max+1 in-tx; the (documentId, versionNumber)
      // unique turns a concurrent replacement into a 409 instead of a duplicate.
      const latest = await tx.documentVersion.findFirst({
        where: { documentId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const nextNumber = (latest?.versionNumber ?? 0) + 1;

      let version;
      try {
        version = await tx.documentVersion.create({
          data: {
            documentId,
            versionNumber: nextNumber,
            storageKey,
            originalFileName: checked.originalFileName,
            sniffedContentType: checked.sniffedContentType,
            sizeBytes: checked.sizeBytes,
            sha256: checked.sha256,
            uploadedByUserId: user.userId,
          },
        });
      } catch (err) {
        if (
          typeof err === "object" &&
          err !== null &&
          (err as { code?: string }).code === "P2002"
        ) {
          throw new HttpProblem(
            409,
            ERROR_CODES.conflict,
            "A concurrent replacement was uploaded — retry with the latest version",
          );
        }
        throw err;
      }

      // Prior versions retained (INV-007 set grows); checklist/OCR follow the
      // repointed current version (XBR-016). A replacement resets review to
      // pending — staff reviews the new content.
      await tx.document.update({
        where: { id: documentId },
        data: {
          currentVersionId: version.id,
          status: "pending",
          statusReason: null,
          description: body.description ?? doc.description,
        },
      });

      // XBR-016 / ASYNC-001: replacement enqueues its own tracked job for the
      // NEW current version, in the same transaction (row-before-response).
      const job = await tx.documentJob.create({
        data: {
          documentVersionId: version.id,
          status: "queued",
          attempt: 0,
          maxAttempts: await getNumberSetting("ocr.retryLimit"),
        },
      });
      createdJobId = job.id;

      if (openRequest) {
        await tx.documentRequest.update({
          where: { id: openRequest.id },
          data: { fulfilledByDocumentId: documentId },
        });
      }

      await audit(tx as AuditTransactionClient, {
        actor: user.userId,
        role: user.role,
        actionType: "document-upload",
        applicationId: doc.applicationId,
        entityType: "Document",
        entityId: documentId,
        summary: `Uploaded replacement "${checked.originalFileName}" (version ${nextNumber}) for ${DOCUMENT_TYPE_LABELS[doc.documentType as DocumentTypeValue] ?? doc.documentType}`,
        ip: meta.ip,
        requestId: meta.requestId,
      });

      // §4.8.2 caseworker trigger "document uploaded/replaced by borrower" —
      // via THE notification service (task-036), in-tx, to the active assignee.
      if (user.role === "BORROWER" && access.application.activeAssignmentCaseworkerId) {
        await createNotification(tx, {
          recipientUserId: access.application.activeAssignmentCaseworkerId,
          type: "document-replaced",
          title: "Document replaced",
          body: `The borrower uploaded a replacement (version ${nextNumber}) of ${DOCUMENT_TYPE_LABELS[doc.documentType as DocumentTypeValue] ?? doc.documentType}.`,
          applicationId: doc.applicationId,
        });
      }
    });
  } catch (err) {
    await getStorage()
      .delete(storageKey)
      .catch(() => undefined);
    throw err;
  }

  // task-034 execution handoff (ASYNC-001) — post-commit, response-first.
  if (createdJobId) handOffOcrJobExecution(createdJobId);

  return loadDocumentWire(prisma, documentId);
}

// ---------------------------------------------------------------------------
// GET /api/applications/:id/documents — 200 DocumentListResponse (max 50)
// ---------------------------------------------------------------------------

export async function listDocuments(
  user: SessionUser,
  applicationId: string,
): Promise<DocumentListResponseWire> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-assigned") throw forbiddenProblem("You are not assigned to this application");
    throw notFoundProblem("Application not found");
  }
  // S-2b summary-level reads (unassigned claimable) never expose documents.
  if (access.level !== "full") {
    throw forbiddenProblem("Claim this application to view its documents");
  }

  const rows = await prisma.document.findMany({
    where: { applicationId },
    include: DOCUMENT_INCLUDE,
    orderBy: { createdAt: "asc" },
    take: LIST_MAX,
  });

  const checklistInput = await buildChecklistInput(
    prisma,
    applicationId,
    rows.map((r) => ({
      id: r.id,
      documentType: r.documentType,
      description: r.description,
      status: r.status,
      checklistItemKey: r.checklistItemKey,
      createdAt: r.createdAt,
    })),
  );
  const checklist = evaluateChecklist(checklistInput);

  // §4.2.9 display order: checklist order, then upload time.
  const orderIndex = checklistOrderIndex(checklistInput);
  const sorted = [...rows].sort((a, b) => {
    const ai = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  return { checklist, documents: sorted.map(toDocumentWire) };
}

/**
 * T7-gate seam (task-019, XBR-006): live checklist for an application without
 * scoping (callers guard). Pair with `isChecklistGateSatisfied` from
 * src/lib/pure/checklist.ts.
 */
export async function evaluateApplicationChecklist(
  db: Db,
  applicationId: string,
): Promise<ChecklistItem[]> {
  const docs = await db.document.findMany({
    where: { applicationId },
    select: {
      id: true,
      documentType: true,
      description: true,
      status: true,
      checklistItemKey: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: LIST_MAX,
  });
  return evaluateChecklist(await buildChecklistInput(db, applicationId, docs));
}

// ---------------------------------------------------------------------------
// Downloads (streamed, SEC-12/SEC-14)
// ---------------------------------------------------------------------------

export interface DocumentDownload {
  stream: ReadableStream<Uint8Array>;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

async function requireDocumentReadAccess(
  user: SessionUser,
  documentId: string,
): Promise<{ id: string; applicationId: string; currentVersionId: string | null }> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, applicationId: true, currentVersionId: true },
  });
  if (!doc) throw notFoundProblem("Document not found");

  const access = await canReadApplication(user, doc.applicationId);
  if (!access.allowed) {
    // Borrower probing another borrower's document id: 404, no existence disclosure.
    if (access.reason === "not-owner") throw notFoundProblem("Document not found");
    if (access.reason === "not-assigned") throw forbiddenProblem("You are not assigned to this application");
    throw notFoundProblem("Document not found");
  }
  if (access.level !== "full") {
    throw forbiddenProblem("Claim this application to download its documents");
  }
  return doc;
}

/** GET /api/documents/:id/download — current version, streamed. */
export async function getDocumentDownload(
  user: SessionUser,
  documentId: string,
): Promise<DocumentDownload> {
  const doc = await requireDocumentReadAccess(user, documentId);
  if (!doc.currentVersionId) throw notFoundProblem("Document not found");
  const version = await prisma.documentVersion.findUnique({
    where: { id: doc.currentVersionId },
    select: { storageKey: true, originalFileName: true, sniffedContentType: true, sizeBytes: true },
  });
  if (!version) throw notFoundProblem("Document not found");
  return {
    stream: await getStorage().openReadStream(version.storageKey),
    fileName: sanitizeDownloadFileName(version.originalFileName),
    contentType: version.sniffedContentType,
    sizeBytes: version.sizeBytes,
  };
}

/**
 * GET /api/documents/:id/versions/:versionId/download — staff only (route
 * roleGate); caseworker must hold the active assignment. The version must
 * belong to the document (404 otherwise).
 */
export async function getDocumentVersionDownload(
  user: SessionUser,
  documentId: string,
  versionId: string,
): Promise<DocumentDownload> {
  const doc = await requireDocumentReadAccess(user, documentId);
  const version = await prisma.documentVersion.findUnique({
    where: { id: versionId },
    select: {
      documentId: true,
      storageKey: true,
      originalFileName: true,
      sniffedContentType: true,
      sizeBytes: true,
    },
  });
  if (!version || version.documentId !== doc.id) throw notFoundProblem("Version not found");
  return {
    stream: await getStorage().openReadStream(version.storageKey),
    fileName: sanitizeDownloadFileName(version.originalFileName),
    contentType: version.sniffedContentType,
    sizeBytes: version.sizeBytes,
  };
}

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id — borrower, owner, Draft only (204)
// ---------------------------------------------------------------------------

export async function deleteDocument(
  user: SessionUser,
  documentId: string,
  meta: RequestMetaBundle,
): Promise<void> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      applicationId: true,
      documentType: true,
      application: { select: { borrowerUserId: true, workflowState: true } },
      versions: { select: { storageKey: true } },
    },
  });
  if (!doc) throw notFoundProblem("Document not found");
  // Route roleGate is borrower-only; a borrower who is not the owner gets 404
  // (no existence disclosure).
  if (doc.application.borrowerUserId !== user.userId) throw notFoundProblem("Document not found");
  if (doc.application.workflowState !== "draft") {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "Documents can be deleted only while the application is in Draft",
    );
  }

  const storageKeys = doc.versions.map((v) => v.storageKey);

  // Rows first, atomically (INV-007: document + versions leave together via
  // cascade; a null currentVersionId never survives outside the tx), audited.
  await prisma.$transaction(async (tx) => {
    // Break the NoAction currentVersion FK before the cascade removes versions.
    await tx.document.update({ where: { id: documentId }, data: { currentVersionId: null } });
    await tx.document.delete({ where: { id: documentId } });
    await audit(tx as AuditTransactionClient, {
      actor: user.userId,
      role: user.role,
      actionType: "document-delete",
      applicationId: doc.applicationId,
      entityType: "Document",
      entityId: documentId,
      summary: `Deleted ${DOCUMENT_TYPE_LABELS[doc.documentType as DocumentTypeValue] ?? doc.documentType} document and its ${storageKeys.length} version(s)`,
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  // Objects second: a failed object delete must NOT resurrect rows — log and
  // continue (orphaned objects are reconciler territory).
  for (const key of storageKeys) {
    try {
      await getStorage().delete(key);
    } catch (err) {
      console.error(
        `[task-013] document ${documentId}: failed to delete storage object ${key} — continuing`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/status — staff review (200 Document)
// ---------------------------------------------------------------------------

export async function changeDocumentStatus(
  user: SessionUser,
  documentId: string,
  body: DocumentStatusRequest,
  meta: RequestMetaBundle,
): Promise<DocumentWire> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, applicationId: true, status: true, statusReason: true },
  });
  if (!doc) throw notFoundProblem("Document not found");

  const access = await canWriteApplication(user, doc.applicationId);
  if (!access.allowed) throwScopeDenial(access.reason);

  await prisma.$transaction(async (tx) => {
    await tx.document.update({
      where: { id: documentId },
      data: {
        status: body.status,
        statusReason: body.reason ?? null,
      },
    });
    // VR-097/098 audited with before/after (SEC-8 document-status-change).
    await audit(tx as AuditTransactionClient, {
      actor: user.userId,
      role: user.role,
      actionType: "document-status-change",
      applicationId: doc.applicationId,
      entityType: "Document",
      entityId: documentId,
      summary: `Document status changed from ${doc.status} to ${body.status}`,
      before: { status: doc.status, statusReason: doc.statusReason },
      after: { status: body.status, statusReason: body.reason ?? null },
      reason: body.reason ?? null,
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  return loadDocumentWire(prisma, documentId);
}

// ---------------------------------------------------------------------------
// Document requests (REQ-053, VR-099/100, XBR-024)
// ---------------------------------------------------------------------------

/** POST /api/applications/:id/document-requests — staff creates (201). */
export async function createDocumentRequest(
  user: SessionUser,
  applicationId: string,
  body: DocumentRequestCreate,
  meta: RequestMetaBundle,
): Promise<DocumentRequestInfoWire> {
  const access = await canWriteApplication(user, applicationId);
  if (!access.allowed) throwScopeDenial(access.reason);

  const typeLabel = DOCUMENT_TYPE_LABELS[body.documentType as DocumentTypeValue] ?? body.documentType;

  const requestId = await prisma.$transaction(async (tx) => {
    const row = await tx.documentRequest.create({
      data: {
        applicationId,
        documentType: body.documentType,
        reason: body.reason,
        requestedByUserId: user.userId,
      },
    });

    // §4.2.9/REQ-053 + §4.8.2 borrower trigger "document requested": via THE
    // notification service (task-036, §4.8.1 single-service mandate) — in-app
    // row in this transaction, external email/SMS per preference post-commit.
    await createNotification(tx, {
      recipientUserId: access.application.borrowerUserId,
      type: "document-request",
      title: "Additional document requested",
      body: `Your loan team requested a document: ${typeLabel}. Reason: ${body.reason}`,
      applicationId,
    });

    await audit(tx as AuditTransactionClient, {
      actor: user.userId,
      role: user.role,
      actionType: "document-request",
      applicationId,
      entityType: "DocumentRequest",
      entityId: row.id,
      summary: `Requested ${typeLabel} from the borrower — ${body.reason}`,
      ip: meta.ip,
      requestId: meta.requestId,
    });

    return row.id;
  });

  const created = await prisma.documentRequest.findUnique({
    where: { id: requestId },
    include: { requestedByUser: { select: { firstName: true, lastName: true } } },
  });
  if (!created) throw notFoundProblem("Document request not found");
  return toDocumentRequestWire(created);
}

/** GET /api/applications/:id/document-requests — 200 DocumentRequestList (max 50). */
export async function listDocumentRequests(
  user: SessionUser,
  applicationId: string,
): Promise<DocumentRequestListWire> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-assigned") throw forbiddenProblem("You are not assigned to this application");
    throw notFoundProblem("Application not found");
  }
  if (access.level !== "full") {
    throw forbiddenProblem("Claim this application to view its document requests");
  }

  const rows = await prisma.documentRequest.findMany({
    where: { applicationId },
    include: { requestedByUser: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: "asc" },
    take: LIST_MAX,
  });
  return { rows: rows.map(toDocumentRequestWire) };
}
