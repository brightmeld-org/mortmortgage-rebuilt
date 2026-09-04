// Application lifecycle service (task-011): create (idempotent + section copy +
// hand-off), borrower dashboard list, detail read, draft delete, co-borrower
// add/remove, owner identity read, validation summary, versions + diff.
//
// REQ-020/021/022/034/036/049/052, XBR-020, INV-014/016/025/026/027/035/036/039.
// Route handlers stay thin: they guard, parse, call these functions, and map
// HttpProblem to the single ErrorResponse shape.

import type { Prisma, PrismaClient, UserRole, WorkflowState } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import {
  canReadApplication,
  requireBorrowerOwnedAction,
} from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { pageEnvelope, type PageEnvelope, type Pagination } from "@/lib/http/pagination";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit } from "@/lib/services/audit";
import { getNumberSetting } from "@/lib/services/config";
import { decryptField } from "@/lib/crypto/encryption";
import {
  APPLICATION_INCLUDE,
  buildVersionSnapshot,
  serializeApplication,
  serializeVersionInfo,
  type ApplicationWithRelations,
} from "@/lib/services/application-serializer";
import { invalidateSignaturesOnDataChange, currentlySignedOrdinals } from "@/lib/services/signature-validity";
import { withSlaFields, type SlaEnrichableRow } from "@/lib/services/sla";
import { computeApplicationQualification, getQualificationThresholds } from "@/lib/services/qualification";
import { verifyHandoffToken, type HandoffPrefill } from "@/lib/services/handoff-token";
import {
  availableTransitions,
  isBorrowerEditableState,
  workflowStateLabel,
} from "@/lib/pure/workflow";
import {
  buildValidationSummary,
  type ApplicationValidationInput,
  type BorrowerValidationInput,
  type ValidationSummary,
  type WizardSection,
} from "@/lib/pure/urla-validation";
import type { CreateApplicationRequest } from "@/lib/schemas/application";
import { WIZARD_SECTIONS } from "@/lib/schemas/application";

type Db = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Human section labels (§4.2.3 list) for advisory messages and diffs. */
export const SECTION_LABELS: Record<WizardSection, string> = {
  identity: "Identity",
  "address-history": "Address History",
  "employment-income": "Employment & Income",
  "assets-reo": "Assets & Real Estate Owned",
  liabilities: "Liabilities",
  "subject-property": "Subject Property",
  "loan-details": "Loan Details",
  declarations: "Declarations",
  demographics: "Demographics",
};

function notFoundProblem(): HttpProblem {
  return new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
}

function forbiddenProblem(message = "You do not have permission to perform this action"): HttpProblem {
  return new HttpProblem(403, ERROR_CODES.forbidden, message);
}

/**
 * Map a requireBorrowerOwnedAction denial (INV-027): staff (incl. Supervisors)
 * → 403; unknown application → 404; another borrower's application → 404 (no
 * existence disclosure to non-owners).
 */
function throwBorrowerActionDenial(reason: "not-found" | "not-owner" | "staff-forbidden"): never {
  if (reason === "staff-forbidden") {
    throw forbiddenProblem("This action belongs to the applying borrower only");
  }
  throw notFoundProblem();
}

/** Load the full relation graph or 404. */
async function loadApplicationWithRelations(
  db: Db,
  applicationId: string,
): Promise<ApplicationWithRelations> {
  const row = await db.application.findUnique({
    where: { id: applicationId },
    include: APPLICATION_INCLUDE,
  });
  if (!row) throw notFoundProblem();
  return row as ApplicationWithRelations;
}

/** Race-safe MM-YYYY-NNNNNN from application_number_seq (INV-014). */
export async function generateApplicationNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('application_number_seq')`;
  const n = rows[0]?.nextval;
  if (n === undefined) throw new Error("application_number_seq returned no value");
  const year = new Date().getUTCFullYear();
  return `MM-${year}-${String(n).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Create (POST /api/applications) — idempotent, copy, hand-off
// ---------------------------------------------------------------------------

interface CopySource {
  application: { id: string; applicationNumber: string };
  borrower1: Record<string, unknown> | null;
  borrowerUpdatedAt: Date | null;
  data: Record<string, unknown> | null;
  dataUpdatedAt: Date | null;
}

const PER_BORROWER_COPY_FIELDS: Record<string, readonly string[]> = {
  identity: [
    "firstName", "middleName", "lastName", "suffix", "alternateNames",
    "ssnCiphertext", "ssnKeyId", "ssnLast4", "ssnBlindIndex",
    "dateOfBirthCiphertext", "dateOfBirthKeyId",
    "citizenship", "maritalStatus", "dependentsCount", "dependentsAges",
    "homePhone", "cellPhone", "workPhone", "workPhoneExt", "email",
    "creditType", "militaryService",
  ],
  "address-history": [
    "currentAddress", "housingStatus", "monthlyRent", "yearsAtAddress",
    "monthsAtAddress", "previousAddresses", "mailingAddress",
  ],
  "employment-income": ["employmentType", "employments", "previousEmployments", "otherIncome"],
  declarations: ["declarations"],
  demographics: ["demographics"],
};

const SHARED_COPY_FIELDS: Record<string, readonly string[]> = {
  "assets-reo": ["assets", "otherCredits", "realEstateOwned"],
  liabilities: ["liabilities", "otherLiabilities"],
  "subject-property": ["subjectProperty"],
  "loan-details": ["loan", "proposedHousingExpense"],
};

function displayDate(d: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Create a Draft (REQ-022). Idempotent per requestToken (SEC-21/NFR-022): a
 * replayed or concurrently-raced token returns the EXISTING application. Section
 * copy is server-side, same-borrower only (XBR-020), audited with source id +
 * section list, and stale sections (source save older than the configured
 * threshold) carry persistent advisories. An invalid/expired handoffToken is
 * ignored (plain Draft — VR-055).
 */
export async function createApplication(
  user: SessionUser,
  body: CreateApplicationRequest,
  meta: RequestMetaBundle,
): Promise<{ application: Record<string, unknown>; replayed: boolean }> {
  // Idempotency replay (fast path, outside the tx).
  const existing = await prisma.application.findUnique({
    where: {
      borrowerUserId_createRequestToken: {
        borrowerUserId: user.userId,
        createRequestToken: body.requestToken,
      },
    },
    include: APPLICATION_INCLUDE,
  });
  if (existing) {
    return { application: serializeApplication(existing as ApplicationWithRelations, user.role), replayed: true };
  }

  // Copy source: must exist AND belong to THIS borrower (XBR-020) — 403 otherwise
  // (the §B error set for this endpoint is validation error/403/409).
  const copySections = (body.copySections ?? []) as WizardSection[];
  let source: CopySource | null = null;
  if (body.copyFromApplicationId) {
    const src = await prisma.application.findUnique({
      where: { id: body.copyFromApplicationId },
      select: {
        id: true,
        applicationNumber: true,
        borrowerUserId: true,
        borrowers: { where: { ordinal: 1 }, take: 1 },
        data: true,
      },
    });
    if (!src || src.borrowerUserId !== user.userId) {
      throw forbiddenProblem("Sections can only be copied from your own application");
    }
    const b1 = src.borrowers[0] ?? null;
    source = {
      application: { id: src.id, applicationNumber: src.applicationNumber },
      borrower1: b1 ? ({ ...b1 } as unknown as Record<string, unknown>) : null,
      borrowerUpdatedAt: b1?.updatedAt ?? null,
      data: src.data ? ({ ...src.data } as unknown as Record<string, unknown>) : null,
      dataUpdatedAt: src.data?.updatedAt ?? null,
    };
  }

  // Hand-off prefill (silent-ignore on invalid/expired — VR-055).
  const prefill: HandoffPrefill | null = body.handoffToken
    ? verifyHandoffToken(body.handoffToken)
    : null;

  const staleThresholdDays = await getNumberSetting("application.staleCopyThresholdDays");

  try {
    const created = await prisma.$transaction(async (tx) => {
      const applicationNumber = await generateApplicationNumber(tx);
      const now = new Date();

      // --- Assemble ordinal-1 borrower data (prefilled with the account email) ---
      const borrowerData: Record<string, unknown> = { ordinal: 1, email: user.email };
      // Hand-off Step 3 income prefill (FLOW-001) — applied first; explicit copy wins.
      if (prefill?.grossMonthlyIncome !== undefined) {
        borrowerData.employmentType = "employed";
        borrowerData.employments = [
          {
            id: randomUUID(),
            employerName: "",
            selfEmployed: false,
            baseMonthlyIncome: prefill.grossMonthlyIncome,
          },
        ];
      }

      // --- Assemble shared ApplicationData (hand-off Steps 5 and 7) ---
      const sharedData: Record<string, unknown> = {};
      if (prefill?.monthlyDebtPayments !== undefined && prefill.monthlyDebtPayments > 0) {
        sharedData.otherLiabilities = [
          { id: randomUUID(), type: "other", monthlyPayment: prefill.monthlyDebtPayments },
        ];
      }
      const loanPrefill: Record<string, unknown> = {};
      if (prefill?.loanAmount !== undefined) loanPrefill.requestedLoanAmount = prefill.loanAmount;
      if (prefill?.downPaymentAmount !== undefined) loanPrefill.downPaymentAmount = prefill.downPaymentAmount;
      if (prefill?.termMonths !== undefined && [120, 180, 240, 360].includes(prefill.termMonths)) {
        loanPrefill.loanTermMonths = prefill.termMonths;
      }
      if (prefill?.loanType !== undefined) loanPrefill.loanType = prefill.loanType;
      if (Object.keys(loanPrefill).length > 0) sharedData.loan = loanPrefill;

      // --- Section copy (overwrites hand-off prefill for copied sections) ---
      const advisories: { section: string; sourceSavedAt: string; message: string }[] = [];
      const staleCutoff = new Date(now.getTime() - staleThresholdDays * 86_400_000);
      if (source) {
        for (const section of copySections) {
          const perBorrower = PER_BORROWER_COPY_FIELDS[section];
          const shared = SHARED_COPY_FIELDS[section];
          let sourceSavedAt: Date | null = null;
          if (perBorrower && source.borrower1) {
            for (const field of perBorrower) {
              const v = source.borrower1[field];
              if (v !== null && v !== undefined) borrowerData[field] = v;
            }
            sourceSavedAt = source.borrowerUpdatedAt;
          } else if (shared && source.data) {
            for (const field of shared) {
              const v = source.data[field];
              if (v !== null && v !== undefined) sharedData[field] = v;
            }
            sourceSavedAt = source.dataUpdatedAt;
          }
          // §4.2.3 staleness advisory: source last saved > threshold before the copy.
          if (sourceSavedAt && sourceSavedAt.getTime() < staleCutoff.getTime()) {
            advisories.push({
              section,
              sourceSavedAt: sourceSavedAt.toISOString(),
              message: `The ${SECTION_LABELS[section]} section you copied is from an application dated ${displayDate(sourceSavedAt)}. Please review and update before submitting.`,
            });
          }
        }
      }

      const app = await tx.application.create({
        data: {
          applicationNumber,
          borrowerUserId: user.userId,
          createRequestToken: body.requestToken,
          copiedFromApplicationId: source?.application.id ?? null,
          staleCopyAdvisories: advisories as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.borrower.create({
        data: {
          applicationId: app.id,
          ...(borrowerData as object),
        } as Prisma.BorrowerUncheckedCreateInput,
      });

      if (Object.keys(sharedData).length > 0) {
        await tx.applicationData.create({
          data: { applicationId: app.id, ...(sharedData as object) } as Prisma.ApplicationDataUncheckedCreateInput,
        });
      }

      await audit(tx, {
        actor: user.userId,
        role: user.role,
        actionType: "application-created",
        applicationId: app.id,
        entityType: "Application",
        entityId: app.id,
        summary: `Application ${applicationNumber} created${source ? ` copying sections from ${source.application.applicationNumber}` : ""}${prefill ? " with pre-qualification hand-off pre-fill" : ""}`,
        ip: meta.ip,
        requestId: meta.requestId,
      });

      if (source) {
        // XBR-020: copy audited with source application id + section list.
        await audit(tx, {
          actor: user.userId,
          role: user.role,
          actionType: "section-copy",
          applicationId: app.id,
          entityType: "Application",
          entityId: app.id,
          summary: `Sections copied from ${source.application.applicationNumber}: ${copySections.join(", ")}`,
          after: { sourceApplicationId: source.application.id, sections: copySections },
          ip: meta.ip,
          requestId: meta.requestId,
        });
      }

      return app;
    });

    const full = await loadApplicationWithRelations(prisma, created.id);
    return { application: serializeApplication(full, user.role), replayed: false };
  } catch (err) {
    // Concurrent same-token race: the unique (borrowerUserId, createRequestToken)
    // insert lost — return the row the winner created (SEC-21).
    if (isUniqueViolation(err, "createRequestToken")) {
      const winner = await prisma.application.findUnique({
        where: {
          borrowerUserId_createRequestToken: {
            borrowerUserId: user.userId,
            createRequestToken: body.requestToken,
          },
        },
        include: APPLICATION_INCLUDE,
      });
      if (winner) {
        return { application: serializeApplication(winner as ApplicationWithRelations, user.role), replayed: true };
      }
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown, targetContains?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  if (!targetContains) return true;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(targetContains));
  if (typeof target === "string") return target.includes(targetContains);
  // Some engines report only the index name — accept any P2002 when unsure.
  return true;
}

// ---------------------------------------------------------------------------
// Borrower dashboard list (GET /api/applications)
// ---------------------------------------------------------------------------

const WORKFLOW_STATES: readonly string[] = [
  "draft", "application_received", "completeness_validated", "documents_received",
  "aus_executed", "preliminary_decision", "escalated_review", "conditional_approval",
  "approved", "denied", "borrower_notified", "revision_requested", "suspended",
  "withdrawn", "declined_by_borrower",
];

/** §4.2.1 per-row actions by state (availableActions values). */
function availableActionsFor(state: WorkflowState, outcome: string | null): string[] {
  const actions: string[] = [];
  actions.push(isBorrowerEditableState(state) ? "continue" : "view");
  const borrowerTos = availableTransitions(state, "BORROWER");
  if (borrowerTos.includes("withdrawn")) actions.push("withdraw");
  if (borrowerTos.includes("declined_by_borrower")) {
    // T35 is only valid when the retained outcome is approved (§A map note).
    if (state !== "borrower_notified" || outcome === "approved") actions.push("decline");
  }
  if (state === "draft") actions.push("delete-draft");
  return actions;
}

/**
 * BorrowerApplicationList (REQ-020): the borrower's OWN applications only
 * (record-level scoping via the WHERE clause), offset-limit paginated, with the
 * §4.2.1 summary cards computed over ALL of their applications.
 */
export async function listBorrowerApplications(
  user: SessionUser,
  pagination: Pagination,
  stateFilter: string | null,
): Promise<Record<string, unknown>> {
  if (stateFilter !== null && !WORKFLOW_STATES.includes(stateFilter)) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: [`state: "${stateFilter}" is not a WorkflowState value`],
    });
  }

  const where: Prisma.ApplicationWhereInput = {
    borrowerUserId: user.userId, // S-1 session scoping — never trust route alone
    ...(stateFilter ? { workflowState: stateFilter as WorkflowState } : {}),
  };

  const [rows, total, allStates] = await Promise.all([
    prisma.application.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      select: {
        id: true,
        applicationNumber: true,
        createdAt: true,
        submittedAt: true,
        workflowState: true,
        outcome: true,
        data: { select: { loan: true, subjectProperty: true } },
      },
    }),
    prisma.application.count({ where }),
    prisma.application.findMany({
      where: { borrowerUserId: user.userId },
      select: { workflowState: true, outcome: true },
      take: 1000,
    }),
  ]);

  const wireRows = rows.map((row) => {
    const loan = row.data?.loan as Record<string, unknown> | null;
    const sp = row.data?.subjectProperty as Record<string, unknown> | null;
    const address = (sp?.address ?? null) as Record<string, unknown> | null;
    const city = typeof address?.city === "string" ? address.city : null;
    const state = typeof address?.state === "string" ? address.state : null;
    const loanAmount =
      typeof loan?.requestedLoanAmount === "number" ? loan.requestedLoanAmount : undefined;
    return {
      id: row.id,
      applicationNumber: row.applicationNumber,
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : undefined,
      workflowState: row.workflowState,
      workflowStateLabel: workflowStateLabel(row.workflowState),
      loanAmount,
      propertyCityState: city && state ? `${city}, ${state}` : undefined,
      outcome: row.outcome ?? undefined,
      availableActions: availableActionsFor(row.workflowState, row.outcome),
    };
  });

  // §4.2.1 summary cards over ALL of the borrower's applications.
  const cards = { total: allStates.length, draft: 0, inUnderwriting: 0, approved: 0, denied: 0, withdrawn: 0 };
  for (const { workflowState, outcome } of allStates) {
    switch (workflowState) {
      case "draft":
        cards.draft += 1;
        break;
      case "approved":
      case "conditional_approval":
        cards.approved += 1;
        break;
      case "denied":
        cards.denied += 1;
        break;
      case "borrower_notified":
        if (outcome === "denied") cards.denied += 1;
        else cards.approved += 1;
        break;
      case "withdrawn":
      case "declined_by_borrower":
        cards.withdrawn += 1;
        break;
      default:
        cards.inUnderwriting += 1;
        break;
    }
  }

  const envelope: PageEnvelope<Record<string, unknown>> = pageEnvelope(wireRows, pagination, total);
  return { rows: envelope.rows, cards, page: envelope.page, pageSize: envelope.pageSize, total: envelope.total };
}

// ---------------------------------------------------------------------------
// Detail read (GET /api/applications/:id)
// ---------------------------------------------------------------------------

/**
 * Full §A Application for borrower (own — S-1), assigned caseworker (S-2a), or
 * supervisor (S-4). A caseworker's unassigned summary-level access (S-2b) does
 * NOT reach this full-detail endpoint — queue endpoints serve summaries.
 */
export async function getApplicationWire(
  user: SessionUser,
  applicationId: string,
): Promise<Record<string, unknown>> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found" || access.reason === "not-owner") throw notFoundProblem();
    throw forbiddenProblem();
  }
  if (access.level !== "full") {
    throw forbiddenProblem("Claim this application to view its details");
  }
  const row = await loadApplicationWithRelations(prisma, applicationId);
  // task-021: live slaStatus / overallSlaDaysRemaining + automatic-priority
  // refresh (no-op for drafts — no clock before submission).
  return withSlaFields(
    serializeApplication(row, user.role),
    row as unknown as SlaEnrichableRow,
  );
}

// ---------------------------------------------------------------------------
// Draft delete (DELETE /api/applications/:id)
// ---------------------------------------------------------------------------

/** Borrower-owned, Draft ONLY (409 otherwise), audited in-transaction (INV-027). */
export async function deleteDraft(
  user: SessionUser,
  applicationId: string,
  meta: RequestMetaBundle,
): Promise<void> {
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  await prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: { id: true, applicationNumber: true, workflowState: true },
    });
    if (!app) throw notFoundProblem();
    if (app.workflowState !== "draft") {
      throw new HttpProblem(409, ERROR_CODES.conflict, "Only Draft applications can be deleted", {
        currentState: app.workflowState,
      });
    }
    // Audit BEFORE the delete: the FK is SetNull so the entry survives (INV-009).
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "application-deleted",
      applicationId: app.id,
      entityType: "Application",
      entityId: app.id,
      summary: `Draft application ${app.applicationNumber} deleted by the borrower`,
      ip: meta.ip,
      requestId: meta.requestId,
    });
    await tx.application.delete({ where: { id: app.id } });
  });
}

// ---------------------------------------------------------------------------
// Co-borrower add / remove (REQ-034, INV-027, INV-035)
// ---------------------------------------------------------------------------

async function loadEditableForBorrowerAction(
  tx: Prisma.TransactionClient,
  applicationId: string,
): Promise<{ id: string; applicationNumber: string; workflowState: WorkflowState; versionStamp: number }> {
  const app = await tx.application.findUnique({
    where: { id: applicationId },
    select: { id: true, applicationNumber: true, workflowState: true, versionStamp: true },
  });
  if (!app) throw notFoundProblem();
  if (!isBorrowerEditableState(app.workflowState)) {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "Co-borrower changes are only allowed in Draft or Revision Requested",
      { currentState: app.workflowState },
    );
  }
  return app;
}

/** POST /api/applications/:id/co-borrower — 201 Application. */
export async function addCoBorrower(
  user: SessionUser,
  applicationId: string,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  try {
    await prisma.$transaction(async (tx) => {
      const app = await loadEditableForBorrowerAction(tx, applicationId);
      // INV-035 service check (the DB unique (applicationId, ordinal) is the race backstop).
      const existing = await tx.borrower.findUnique({
        where: { applicationId_ordinal: { applicationId, ordinal: 2 } },
        select: { id: true },
      });
      if (existing) {
        throw new HttpProblem(409, ERROR_CODES.conflict, "This application already has a co-borrower");
      }
      const coBorrower = await tx.borrower.create({
        data: { applicationId, ordinal: 2 },
      });
      // Data changed (new borrower row) → signature invalidation (XBR-003/INV-029).
      await invalidateSignaturesOnDataChange(tx, applicationId);
      await tx.application.update({
        where: { id: applicationId },
        data: { versionStamp: { increment: 1 } },
      });
      await audit(tx, {
        actor: user.userId,
        role: user.role,
        actionType: "co-borrower-add",
        applicationId,
        entityType: "Borrower",
        entityId: coBorrower.id,
        summary: `Co-borrower added to application ${app.applicationNumber}`,
        ip: meta.ip,
        requestId: meta.requestId,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, "ordinal")) {
      throw new HttpProblem(409, ERROR_CODES.conflict, "This application already has a co-borrower");
    }
    throw err;
  }

  const row = await loadApplicationWithRelations(prisma, applicationId);
  return serializeApplication(row, user.role);
}

/** DELETE /api/applications/:id/co-borrower — 200 Application. */
export async function removeCoBorrower(
  user: SessionUser,
  applicationId: string,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  await prisma.$transaction(async (tx) => {
    const app = await loadEditableForBorrowerAction(tx, applicationId);
    const coBorrower = await tx.borrower.findUnique({
      where: { applicationId_ordinal: { applicationId, ordinal: 2 } },
      select: { id: true },
    });
    if (!coBorrower) {
      throw new HttpProblem(409, ERROR_CODES.conflict, "This application has no co-borrower to remove");
    }
    // Deletes the co-borrower's data; their signatures cascade with the row.
    await tx.borrower.delete({ where: { id: coBorrower.id } });
    // Remaining (primary) signatures cover changed data → invalidate (XBR-003).
    await invalidateSignaturesOnDataChange(tx, applicationId);
    await tx.application.update({
      where: { id: applicationId },
      data: { versionStamp: { increment: 1 } },
    });
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "co-borrower-remove",
      applicationId,
      entityType: "Borrower",
      entityId: coBorrower.id,
      summary: `Co-borrower removed from application ${app.applicationNumber}`,
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  const row = await loadApplicationWithRelations(prisma, applicationId);
  return serializeApplication(row, user.role);
}

// ---------------------------------------------------------------------------
// Owner identity read (GET /api/applications/:id/borrowers/:ordinal/identity)
// ---------------------------------------------------------------------------

/**
 * BorrowerIdentityOwn — THE ONLY egress of the full SSN and raw ISO DOB (S-5,
 * REQ-006). Owner borrower only; staff are stopped by the route's roleGate and
 * non-owners see 404 here.
 */
export async function getBorrowerIdentityOwn(
  user: SessionUser,
  applicationId: string,
  ordinal: number,
): Promise<Record<string, unknown>> {
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  const borrower = await prisma.borrower.findUnique({
    where: { applicationId_ordinal: { applicationId, ordinal } },
  });
  if (!borrower) throw notFoundProblem();

  const ssn =
    borrower.ssnCiphertext && borrower.ssnKeyId
      ? decryptField({ ciphertext: borrower.ssnCiphertext, keyId: borrower.ssnKeyId })
      : undefined;
  const dateOfBirth =
    borrower.dateOfBirthCiphertext && borrower.dateOfBirthKeyId
      ? decryptField({ ciphertext: borrower.dateOfBirthCiphertext, keyId: borrower.dateOfBirthKeyId })
      : undefined;

  const identity: Record<string, unknown> = {
    firstName: borrower.firstName ?? undefined,
    middleName: borrower.middleName ?? undefined,
    lastName: borrower.lastName ?? undefined,
    suffix: borrower.suffix ?? undefined,
    alternateNames: borrower.alternateNames.length > 0 ? borrower.alternateNames : undefined,
    ssn,
    dateOfBirth,
    citizenship: borrower.citizenship ?? undefined,
    maritalStatus: borrower.maritalStatus ?? undefined,
    dependentsCount: borrower.dependentsCount ?? undefined,
    dependentsAges: borrower.dependentsAges ?? undefined,
    homePhone: borrower.homePhone ?? undefined,
    cellPhone: borrower.cellPhone ?? undefined,
    workPhone: borrower.workPhone ?? undefined,
    workPhoneExt: borrower.workPhoneExt ?? undefined,
    email: borrower.email ?? undefined,
    creditType: borrower.creditType ?? undefined,
    militaryService: borrower.militaryService ?? undefined,
  };

  return { ordinal: borrower.ordinal, identity };
}

// ---------------------------------------------------------------------------
// Validation summary (GET /api/applications/:id/validation)
// ---------------------------------------------------------------------------

/** Map live rows to the pure engine's input (decrypting DOB — INV-025 age check). */
export async function buildValidationInput(
  db: Db,
  applicationId: string,
): Promise<ApplicationValidationInput> {
  const app = await db.application.findUnique({
    where: { id: applicationId },
    select: { id: true, createdAt: true },
  });
  if (!app) throw notFoundProblem();
  const borrowers = await db.borrower.findMany({
    where: { applicationId },
    orderBy: { ordinal: "asc" },
    take: 2,
  });
  const data = await db.applicationData.findUnique({ where: { applicationId } });

  const qualification = await computeApplicationQualification(applicationId, db);
  const thresholds = qualification.thresholds;
  const signedOrdinals = await currentlySignedOrdinals(db, applicationId);

  const borrowerInputs: BorrowerValidationInput[] = borrowers.map((b) => ({
    ordinal: b.ordinal,
    firstName: b.firstName,
    lastName: b.lastName,
    hasSsn: b.ssnCiphertext !== null,
    dateOfBirth:
      b.dateOfBirthCiphertext && b.dateOfBirthKeyId
        ? decryptField({ ciphertext: b.dateOfBirthCiphertext, keyId: b.dateOfBirthKeyId })
        : null,
    citizenship: b.citizenship,
    maritalStatus: b.maritalStatus,
    homePhone: b.homePhone,
    cellPhone: b.cellPhone,
    workPhone: b.workPhone,
    email: b.email,
    creditType: b.creditType,
    militaryService: b.militaryService as Record<string, unknown> | null,
    currentAddress: b.currentAddress as Record<string, unknown> | null,
    housingStatus: b.housingStatus,
    monthlyRent: b.monthlyRent === null ? null : Number(b.monthlyRent),
    yearsAtAddress: b.yearsAtAddress,
    monthsAtAddress: b.monthsAtAddress,
    previousAddresses: b.previousAddresses as Record<string, unknown>[] | null,
    employmentType: b.employmentType,
    employments: b.employments as Record<string, unknown>[] | null,
    previousEmployments: b.previousEmployments as Record<string, unknown>[] | null,
    otherIncome: b.otherIncome as Record<string, unknown>[] | null,
    declarations: b.declarations as Record<string, unknown> | null,
    demographics: b.demographics as Record<string, unknown> | null,
  }));

  return {
    borrowers: borrowerInputs,
    data: data
      ? {
          assets: data.assets as Record<string, unknown>[] | null,
          otherCredits: data.otherCredits as Record<string, unknown>[] | null,
          realEstateOwned: data.realEstateOwned as Record<string, unknown>[] | null,
          liabilities: data.liabilities as Record<string, unknown>[] | null,
          otherLiabilities: data.otherLiabilities as Record<string, unknown>[] | null,
          subjectProperty: data.subjectProperty as Record<string, unknown> | null,
          loan: data.loan as Record<string, unknown> | null,
          proposedHousingExpense: data.proposedHousingExpense as Record<string, unknown> | null,
        }
      : null,
    ltv: qualification.ltv,
    ltvWarningPercent: thresholds.ltvWarningPercent,
    ltvSubmissionBlockPercent: thresholds.ltvSubmissionBlockPercent,
    applicationDate: app.createdAt,
    signedOrdinals,
  };
}

/** ValidationSummary for borrower (own) or staff readers (REQ-036). */
export async function getValidationSummary(
  user: SessionUser,
  applicationId: string,
): Promise<ValidationSummary> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found" || access.reason === "not-owner") throw notFoundProblem();
    throw forbiddenProblem();
  }
  if (access.level !== "full") throw forbiddenProblem();
  const input = await buildValidationInput(prisma, applicationId);
  return buildValidationSummary(input);
}

// ---------------------------------------------------------------------------
// Versions (GET /api/applications/:id/versions[, /diff])
// ---------------------------------------------------------------------------

async function requireFullRead(user: SessionUser, applicationId: string): Promise<void> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found" || access.reason === "not-owner") throw notFoundProblem();
    throw forbiddenProblem();
  }
  if (access.level !== "full") throw forbiddenProblem();
}

/** VersionPage (REQ-052), newest first, offset-limit (max 100 — INV-036). */
export async function listVersions(
  user: SessionUser,
  applicationId: string,
  pagination: Pagination,
): Promise<PageEnvelope<Record<string, unknown>>> {
  await requireFullRead(user, applicationId);
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { currentVersionNumber: true },
  });
  if (!app) throw notFoundProblem();

  const [rows, total] = await Promise.all([
    prisma.applicationVersion.findMany({
      where: { applicationId },
      orderBy: { versionNumber: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.applicationVersion.count({ where: { applicationId } }),
  ]);

  return pageEnvelope(
    rows.map((row) => serializeVersionInfo(row, app.currentVersionNumber)),
    pagination,
    total,
  );
}

// --- Diff (REQ-052): field-level added/removed/changed grouped by URLA section ---

/** Flatten a JSON value into dotted-path → display-string leaves. */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) flatten(v, `${prefix}[${i}]`, out);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix === "" ? k : `${prefix}.${k}`, out);
    }
    return;
  }
  out.set(prefix, String(value));
}

interface SnapshotSections {
  /** section → flattened path → value map. */
  sections: Map<WizardSection, Map<string, string>>;
}

const SHARED_SNAPSHOT_SECTIONS: readonly WizardSection[] = [
  "assets-reo",
  "liabilities",
  "subject-property",
  "loan-details",
];
const PER_BORROWER_SNAPSHOT_SECTIONS: readonly WizardSection[] = [
  "identity",
  "address-history",
  "employment-income",
  "declarations",
  "demographics",
];

function snapshotSections(snapshot: unknown): SnapshotSections {
  const sections = new Map<WizardSection, Map<string, string>>();
  for (const s of WIZARD_SECTIONS) sections.set(s, new Map());
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { sections };
  }
  const root = snapshot as Record<string, unknown>;
  for (const section of SHARED_SNAPSHOT_SECTIONS) {
    flatten(root[section], "", sections.get(section)!);
  }
  const borrowers = Array.isArray(root.borrowers) ? root.borrowers : [];
  for (const b of borrowers) {
    if (b === null || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    const ordinal = typeof rec.ordinal === "number" ? rec.ordinal : 0;
    for (const section of PER_BORROWER_SNAPSHOT_SECTIONS) {
      flatten(rec[section], `borrower${ordinal}`, sections.get(section)!);
    }
  }
  return { sections };
}

/** VersionDiffResponse (REQ-052): masked values only (snapshots are masked at write). */
export async function diffVersions(
  user: SessionUser,
  applicationId: string,
  fromVersion: number,
  toVersion: number,
): Promise<Record<string, unknown>> {
  await requireFullRead(user, applicationId);

  const [fromRow, toRow] = await Promise.all([
    prisma.applicationVersion.findUnique({
      where: { applicationId_versionNumber: { applicationId, versionNumber: fromVersion } },
    }),
    prisma.applicationVersion.findUnique({
      where: { applicationId_versionNumber: { applicationId, versionNumber: toVersion } },
    }),
  ]);
  if (!fromRow || !toRow) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Version not found");
  }

  const fromSections = snapshotSections(fromRow.snapshot).sections;
  const toSections = snapshotSections(toRow.snapshot).sections;

  const sections: { section: WizardSection; changes: Record<string, unknown>[] }[] = [];
  for (const section of WIZARD_SECTIONS) {
    const before = fromSections.get(section)!;
    const after = toSections.get(section)!;
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changes: Record<string, unknown>[] = [];
    for (const path of [...paths].sort()) {
      const b = before.get(path);
      const a = after.get(path);
      if (b === a) continue;
      if (b === undefined) {
        changes.push({ fieldPath: path, changeType: "added", after: a });
      } else if (a === undefined) {
        changes.push({ fieldPath: path, changeType: "removed", before: b });
      } else {
        changes.push({ fieldPath: path, changeType: "changed", before: b, after: a });
      }
    }
    if (changes.length > 0) sections.push({ section, changes });
  }

  return { fromVersion, toVersion, sections };
}

// ---------------------------------------------------------------------------
// Snapshot builder re-export (submission service composes it)
// ---------------------------------------------------------------------------

export { buildVersionSnapshot, loadApplicationWithRelations };

/** Live thresholds passthrough for callers that need them beside the summary. */
export { getQualificationThresholds };
