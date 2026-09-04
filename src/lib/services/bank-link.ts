// Bank-link persistence + orchestration (task-014 — REQ-039, XBR-019, INV-026,
// INV-027, §4.2.10). The simulation itself lives in bank-aggregator.ts /
// pure/bank-simulation.ts; this module owns the DB side:
//
//   createBankLink   — POST   /api/applications/:id/bank-links
//   importBankLink   — POST   /api/applications/:id/bank-links/:linkId/import
//   unlinkBankLink   — DELETE /api/applications/:id/bank-links/:linkId
//
// STATE-RULE RESOLUTION (documented decision — contracts §B lists NO 409 for
// any bank-link endpoint):
//   - LINK (create) is permitted in ANY workflow state: it mutates no
//     application data — it only creates a session — and §B deliberately omits
//     a state-conflict code for it.
//   - IMPORT and UNLINK are application-DATA mutations (asset rows appended /
//     source flipped), so INV-026's "borrower-permitted operations in
//     borrower-editable states" applies exactly as it does to section saves
//     (Draft / Revision Requested). Because §B declares only 403/404 here, the
//     wrong-state rejection maps onto 403 ("action not permitted for this
//     actor in this state") with an explicit message — NOT an undeclared 409.
//
// TOKEN / CREDENTIAL POSTURE (§4.2.10 "link tokens are stored encrypted"):
//   BankLink.accessTokenCiphertext holds the AES-256-GCM envelope (same
//   task-002 envelope as SSN) of a JSON session payload:
//     { v, token, usernameHash, accounts[], incomeEvidence }
//   - The provider access token and the DERIVED account set (incl. the internal
//     full account numbers) live only inside this envelope, so import can
//     validate accountIds against the session without ever storing the
//     username (a hash only) or password (never leaves the exchange call).
//   - Unlink deletes the envelope (ciphertext + keyId → null) — XBR-019.
//
// AUDIT (§4.2.10 / XBR-019): bank-link / bank-import / bank-unlink, in the
// same transaction, actor from session, institution + masked metadata only —
// never username, password, token, or full account numbers.

import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { requireBorrowerOwnedAction } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import { decryptField, encryptField, encryptFieldToJson } from "@/lib/crypto/encryption";
import { invalidateSignaturesOnDataChange } from "@/lib/services/signature-validity";
import { computeApplicationQualification } from "@/lib/services/qualification";
import {
  APPLICATION_INCLUDE,
  serializeApplication,
} from "@/lib/services/application-serializer";
import {
  exchangeCredentials,
  findInstitution,
  bankLinkExchangeLatencyMs,
  isSlowExchange,
  sleep,
} from "@/lib/services/bank-aggregator";
import type { DerivedAccount } from "@/lib/pure/bank-simulation";
import { isBorrowerEditableState } from "@/lib/pure/workflow";
import type { BankLinkAuthRequest, BankLinkImportRequest } from "@/lib/schemas/bank-link";

const PROVIDER = "simulated-aggregator";

// ---------------------------------------------------------------------------
// Wire shapes (contracts §A — exact field names)
// ---------------------------------------------------------------------------

/** contracts §A LinkedAccountInfo. */
export interface LinkedAccountInfo {
  externalAccountId: string;
  accountType: string;
  institution: string;
  last4: string;
  balance: number;
}

/** contracts §A IncomeEvidence. */
export interface IncomeEvidenceInfo {
  employerName: string;
  employerMatch: boolean;
  averageMonthlyDeposit: number;
}

/** contracts §A BankLinkSession. */
export interface BankLinkSessionInfo {
  linkId: string;
  accounts: LinkedAccountInfo[];
  incomeEvidence?: IncomeEvidenceInfo[];
}

// ---------------------------------------------------------------------------
// Encrypted session payload (inside BankLink.accessTokenCiphertext)
// ---------------------------------------------------------------------------

interface SessionPayload {
  v: 1;
  token: string;
  usernameHash: string;
  accounts: DerivedAccount[];
  incomeEvidence: IncomeEvidenceInfo | null;
}

function sealSessionPayload(payload: SessionPayload): {
  ciphertext: Uint8Array<ArrayBuffer>;
  keyId: string;
} {
  const sealed = encryptField(JSON.stringify(payload));
  return { ciphertext: new Uint8Array(sealed.ciphertext), keyId: sealed.keyId };
}

function openSessionPayload(link: {
  accessTokenCiphertext: Uint8Array | null;
  accessTokenKeyId: string | null;
}): SessionPayload {
  if (!link.accessTokenCiphertext || !link.accessTokenKeyId) {
    // Callers gate on unlinkedAt/ciphertext first; this is a defensive backstop.
    throw new HttpProblem(404, ERROR_CODES.notFound, "Bank link not found or no longer active");
  }
  return JSON.parse(
    decryptField({ ciphertext: link.accessTokenCiphertext, keyId: link.accessTokenKeyId }),
  ) as SessionPayload;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** INV-027 denial mapping — same convention as application.ts: staff → 403,
 *  unknown/non-owner → 404 (no existence disclosure to non-owners). */
function throwBorrowerActionDenial(reason: "not-found" | "not-owner" | "staff-forbidden"): never {
  if (reason === "staff-forbidden") {
    throw new HttpProblem(
      403,
      ERROR_CODES.forbidden,
      "This action belongs to the applying borrower only",
    );
  }
  throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
}

/**
 * Deterministic UUID-format id for the asset row created from one linked
 * account: sha256(linkId | externalAccountId) → 32 hex chars with dashes.
 * Determinism makes import idempotent at the data level (a re-imported account
 * can never append a second row) and lets unlink find the imported rows even
 * after borrower edits (row ids survive section saves — task-011 preserves
 * them).
 */
export function importedAssetRowId(linkId: string, externalAccountId: string): string {
  const hex = createHash("sha256").update(`${linkId}|${externalAccountId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toLinkedAccountInfo(account: DerivedAccount, institution: string): LinkedAccountInfo {
  return {
    externalAccountId: account.externalAccountId,
    accountType: account.accountType,
    institution,
    last4: account.last4,
    balance: account.balance,
  };
}

type Row = Record<string, unknown>;

function asRowArray(value: Prisma.JsonValue | null | undefined): Row[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => row !== null && typeof row === "object" && !Array.isArray(row))
    .map((row) => row as Row);
}

/** Serialize the full §A Application for the caller (post-mutation reload). */
async function serializeCurrentApplication(
  tx: Prisma.TransactionClient,
  applicationId: string,
  role: SessionUser["role"],
): Promise<Record<string, unknown>> {
  const row = await tx.application.findUnique({
    where: { id: applicationId },
    include: APPLICATION_INCLUDE,
  });
  if (!row) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  return serializeApplication(row, role);
}

// ---------------------------------------------------------------------------
// createBankLink — POST /api/applications/:id/bank-links
// ---------------------------------------------------------------------------

/**
 * Simulated aggregator link (§6.3.5): validate the institution, run the
 * credential exchange (latency OUTSIDE any transaction), persist the BankLink
 * row with the ENCRYPTED session payload, audit `bank-link`, and return the
 * §A BankLinkSession. Permitted in any workflow state (see module header).
 */
export async function createBankLink(
  user: SessionUser,
  applicationId: string,
  body: BankLinkAuthRequest,
  meta: RequestMetaBundle,
): Promise<BankLinkSessionInfo> {
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  const institution = findInstitution(body.institutionId);
  if (!institution) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Institution not found");
  }

  // LIVE inputs for the income-evidence derivation: the PRIMARY borrower's
  // current Step-3 employments — stated base income = sum of baseMonthlyIncome
  // across current employments; the Step-3 employer = the first current
  // employment's employerName.
  const primary = await prisma.borrower.findUnique({
    where: { applicationId_ordinal: { applicationId, ordinal: 1 } },
    select: { id: true, employments: true },
  });
  let statedBaseMonthlyIncome: number | null = null;
  let step3EmployerName: string | null = null;
  for (const employment of asRowArray(primary?.employments)) {
    const base = employment.baseMonthlyIncome;
    if (typeof base === "number" && base > 0) {
      statedBaseMonthlyIncome = (statedBaseMonthlyIncome ?? 0) + base;
    }
    if (step3EmployerName === null && typeof employment.employerName === "string" && employment.employerName.trim() !== "") {
      step3EmployerName = employment.employerName.trim();
    }
  }

  // §6.3.5 exchange latency (2,000 ± 800 ms; `slow` adds 8 s) — a non-blocking
  // async sleep BEFORE any DB transaction is opened. Applied to failures too:
  // a real provider round-trips before rejecting credentials.
  await sleep(bankLinkExchangeLatencyMs(body.username, isSlowExchange(body.password)));

  const exchange = exchangeCredentials(
    institution,
    body.username,
    body.password,
    statedBaseMonthlyIncome,
    step3EmployerName,
    new Date(),
  );
  if (!exchange.ok) {
    // Simulated institution auth failure (§6.3.5 password `fail`). Contract §B
    // lists 401 for this endpoint; this is the institution-credential failure
    // (code auth_failed), distinct from the guard's session 401 (unauthorized).
    throw new HttpProblem(
      401,
      "auth_failed",
      "Institution authentication failed — the credentials were rejected by the selected institution",
    );
  }

  const payload = sealSessionPayload({
    v: 1,
    token: exchange.accessToken,
    usernameHash: exchange.usernameHash,
    accounts: exchange.accounts,
    incomeEvidence: exchange.incomeEvidence
      ? {
          employerName: exchange.incomeEvidence.employerName,
          employerMatch: exchange.incomeEvidence.employerMatch,
          averageMonthlyDeposit: exchange.incomeEvidence.averageMonthlyDeposit,
        }
      : null,
  });

  const linkId = await prisma.$transaction(async (tx) => {
    const link = await tx.bankLink.create({
      data: {
        applicationId,
        borrowerId: primary?.id ?? null,
        provider: PROVIDER,
        institution: institution.name,
        accessTokenCiphertext: payload.ciphertext,
        accessTokenKeyId: payload.keyId,
      },
    });
    // §4.2.10 "Linking ... audited" — institution + masked metadata only.
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "bank-link",
      applicationId,
      entityType: "BankLink",
      entityId: link.id,
      summary: `Bank account link created to ${institution.name} (${exchange.accounts.length} account${exchange.accounts.length === 1 ? "" : "s"} available)`,
      after: {
        institution: institution.name,
        accounts: exchange.accounts.map((a) => ({
          externalAccountId: a.externalAccountId,
          accountType: a.accountType,
          last4: a.last4,
        })),
      },
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return link.id;
  });

  const session: BankLinkSessionInfo = {
    linkId,
    accounts: exchange.accounts.map((a) => toLinkedAccountInfo(a, institution.name)),
  };
  if (exchange.incomeEvidence) {
    session.incomeEvidence = [
      {
        employerName: exchange.incomeEvidence.employerName,
        employerMatch: exchange.incomeEvidence.employerMatch,
        averageMonthlyDeposit: exchange.incomeEvidence.averageMonthlyDeposit,
      },
    ];
  }
  return session;
}

// ---------------------------------------------------------------------------
// importBankLink — POST /api/applications/:id/bank-links/:linkId/import
// ---------------------------------------------------------------------------

/**
 * XBR-019: create Step-4 asset rows (source `bank-link`) from the selected
 * session accounts, in ONE transaction with signature invalidation (XBR-003),
 * DTI/LTV/CLTV recalc, versionStamp increment, and the `bank-import` audit.
 * Idempotent: an accountId already imported on this link is skipped (its
 * deterministic row id also prevents duplicates structurally); if every
 * requested id is already imported, the call is a no-op returning the current
 * Application. Returns the full §A Application.
 */
export async function importBankLink(
  user: SessionUser,
  applicationId: string,
  linkId: string,
  body: BankLinkImportRequest,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  return prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: { id: true, applicationNumber: true, workflowState: true },
    });
    if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

    // INV-026 data-mutation state rule, mapped to 403 (see module header).
    if (!isBorrowerEditableState(app.workflowState)) {
      throw new HttpProblem(
        403,
        ERROR_CODES.forbidden,
        "Bank-link import is only available while the application is editable (Draft or Revision Requested)",
      );
    }

    // RECORD-LEVEL SCOPING: linkId is resolved WITH applicationId — a linkId
    // belonging to another application is a plain 404, never acted on.
    const link = await tx.bankLink.findFirst({
      where: { id: linkId, applicationId },
    });
    if (!link) throw new HttpProblem(404, ERROR_CODES.notFound, "Bank link not found");
    if (link.unlinkedAt !== null || !link.accessTokenCiphertext) {
      // An unlinked link's session (and encrypted token) no longer exists —
      // the importable resource is gone: 404 (documented resolution).
      throw new HttpProblem(404, ERROR_CODES.notFound, "Bank link not found or no longer active");
    }

    const payload = openSessionPayload(link);
    const sessionAccounts = new Map(payload.accounts.map((a) => [a.externalAccountId, a]));

    // VR-107: every requested id must come from THIS link's session.
    const requested = [...new Set(body.accountIds)];
    const unknown = requested.filter((id) => !sessionAccounts.has(id));
    if (unknown.length > 0) {
      throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
        details: unknown.map((id) => `accountIds: "${id}" is not an account of this bank-link session`),
      });
    }

    // Idempotency: skip ids already imported on this link (double-click safe).
    const alreadyImported = new Set(link.importedAccountIds);
    const newIds = requested.filter((id) => !alreadyImported.has(id));

    if (newIds.length > 0) {
      const data = await tx.applicationData.findUnique({ where: { applicationId } });
      const assets = asRowArray(data?.assets);
      const existingRowIds = new Set(
        assets.map((r) => (typeof r.id === "string" ? r.id : "")).filter((id) => id !== ""),
      );

      const appendedAccounts: DerivedAccount[] = [];
      for (const externalAccountId of newIds) {
        const account = sessionAccounts.get(externalAccountId)!;
        const rowId = importedAssetRowId(link.id, externalAccountId);
        if (existingRowIds.has(rowId)) continue; // structural duplicate guard
        // AssetRecord — contracts §A field names verbatim; the full derived
        // account number is sealed in the task-011 embedded envelope, last4
        // beside it (the wire only ever sees accountNumberLast4).
        assets.push({
          id: rowId,
          accountType: account.accountType,
          financialInstitution: link.institution,
          accountNumber: encryptFieldToJson(account.fullAccountNumber) as unknown,
          accountNumberLast4: account.last4,
          cashOrMarketValue: account.balance,
          source: "bank-link",
        });
        appendedAccounts.push(account);
      }

      if (appendedAccounts.length > 0) {
        await tx.applicationData.upsert({
          where: { applicationId },
          create: { applicationId, assets: assets as unknown as Prisma.InputJsonValue },
          update: { assets: assets as unknown as Prisma.InputJsonValue },
        });
      }
      await tx.bankLink.update({
        where: { id: link.id },
        data: { importedAccountIds: [...alreadyImported, ...newIds] },
      });

      if (appendedAccounts.length > 0) {
        // Same post-mutation steps as a section save (application-data.ts):
        // XBR-003 signature invalidation + shared DTI/LTV/CLTV recalc persisted
        // to the Application row + versionStamp increment — one transaction.
        await invalidateSignaturesOnDataChange(tx, applicationId);
        const qualification = await computeApplicationQualification(applicationId, tx);
        await tx.application.update({
          where: { id: applicationId },
          data: {
            versionStamp: { increment: 1 },
            dti: qualification.dti,
            ltv: qualification.ltv,
            cltv: qualification.cltv,
          },
        });

        // §4.2.10 / XBR-019 audit — masked metadata only, never account numbers.
        await audit(tx, {
          actor: user.userId,
          role: user.role,
          actionType: "bank-import",
          applicationId,
          entityType: "BankLink",
          entityId: link.id,
          summary: `Imported ${appendedAccounts.length} linked account${appendedAccounts.length === 1 ? "" : "s"} from ${link.institution} into application ${app.applicationNumber} assets`,
          after: {
            institution: link.institution,
            importedAccountIds: newIds,
            accounts: appendedAccounts.map((a) => ({
              externalAccountId: a.externalAccountId,
              accountType: a.accountType,
              last4: a.last4,
              balance: a.balance,
            })),
          },
          ip: meta.ip,
          requestId: meta.requestId,
        });

        // §4.8.2 borrower trigger "bank link imported" (task-036) — via THE
        // notification service, in the same transaction.
        await createNotification(tx, {
          recipientUserId: user.userId, // borrower-only action (INV-027) — the actor owns the application
          type: "bank-link-imported",
          title: "Bank accounts imported",
          body: `${appendedAccounts.length} linked account${appendedAccounts.length === 1 ? "" : "s"} from ${link.institution} ${appendedAccounts.length === 1 ? "was" : "were"} imported into the assets of application ${app.applicationNumber}.`,
          applicationId,
        });
      }
    }

    return serializeCurrentApplication(tx, applicationId, user.role);
  });
}

// ---------------------------------------------------------------------------
// unlinkBankLink — DELETE /api/applications/:id/bank-links/:linkId
// ---------------------------------------------------------------------------

/**
 * XBR-019 unlink: remove the encrypted token (ciphertext + keyId → null), mark
 * the link unlinked, flip this link's imported asset rows to source `manual`
 * (rows stay — §4.2.10 "marks imported rows as manual"), invalidate signatures
 * + recalc ratios ONLY when asset data actually changed, audit `bank-unlink`.
 * A second unlink (or an unknown/foreign linkId) is 404. Returns the full §A
 * Application.
 */
export async function unlinkBankLink(
  user: SessionUser,
  applicationId: string,
  linkId: string,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  return prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: { id: true, applicationNumber: true, workflowState: true },
    });
    if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

    // Same data-mutation state rule as import (source flip edits Step-4 data).
    if (!isBorrowerEditableState(app.workflowState)) {
      throw new HttpProblem(
        403,
        ERROR_CODES.forbidden,
        "Bank-link changes are only available while the application is editable (Draft or Revision Requested)",
      );
    }

    const link = await tx.bankLink.findFirst({ where: { id: linkId, applicationId } });
    if (!link || link.unlinkedAt !== null) {
      throw new HttpProblem(404, ERROR_CODES.notFound, "Bank link not found");
    }

    // Flip this link's imported rows to manual (deterministic row ids).
    const importedRowIds = new Set(
      link.importedAccountIds.map((externalId) => importedAssetRowId(link.id, externalId)),
    );
    let flipped = 0;
    if (importedRowIds.size > 0) {
      const data = await tx.applicationData.findUnique({ where: { applicationId } });
      const assets = asRowArray(data?.assets);
      const updatedAssets = assets.map((row) => {
        if (
          typeof row.id === "string" &&
          importedRowIds.has(row.id) &&
          row.source === "bank-link"
        ) {
          flipped += 1;
          return { ...row, source: "manual" };
        }
        return row;
      });
      if (flipped > 0) {
        await tx.applicationData.update({
          where: { applicationId },
          data: { assets: updatedAssets as unknown as Prisma.InputJsonValue },
        });
      }
    }

    // XBR-019: the encrypted token is REMOVED, not just flagged.
    await tx.bankLink.update({
      where: { id: link.id },
      data: {
        unlinkedAt: new Date(),
        accessTokenCiphertext: null,
        accessTokenKeyId: null,
      },
    });

    if (flipped > 0) {
      // The source flip IS a data change: invalidate + recalc + stamp bump,
      // mirroring the section-save post-mutation steps.
      await invalidateSignaturesOnDataChange(tx, applicationId);
      const qualification = await computeApplicationQualification(applicationId, tx);
      await tx.application.update({
        where: { id: applicationId },
        data: {
          versionStamp: { increment: 1 },
          dti: qualification.dti,
          ltv: qualification.ltv,
          cltv: qualification.cltv,
        },
      });
    }

    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "bank-unlink",
      applicationId,
      entityType: "BankLink",
      entityId: link.id,
      summary: `Bank account link to ${link.institution} removed from application ${app.applicationNumber}; ${flipped} imported asset row${flipped === 1 ? "" : "s"} marked manual; access token deleted`,
      after: { institution: link.institution, importedRowsMarkedManual: flipped },
      ip: meta.ip,
      requestId: meta.requestId,
    });

    return serializeCurrentApplication(tx, applicationId, user.role);
  });
}
