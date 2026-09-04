// Wizard section auto-save service (task-011) — PUT /api/applications/:id/sections/:section.
//
// REQ-023/024..032/035/036/040, VR-056..VR-072, VR-126..VR-129, XBR-003, XBR-021,
// INV-025/026/029/036/039, FT-74 (check-then-act inside one transaction, with the
// versionStamp in the WHERE clause of the final conditional update).
//
// Semantics:
//   - Owner borrower only (403 non-owner / staff), Draft or Revision Requested
//     only (409 with currentState otherwise) — §4.2.6.
//   - The section payload REPLACES the stored section. Deliberate exceptions:
//     write-only secrets the client can never echo — an omitted identity `ssn` /
//     `dateOfBirth` leaves the stored value unchanged, and an omitted row
//     `accountNumber` preserves the stored encrypted envelope when the row id
//     matches an existing row — plus the loan-details
//     `proposedHousingExpense` group, whose absence leaves the separately
//     stored group untouched (REQ-030).
//   - SSN: VR-069 format, AES-256-GCM at rest + HMAC blind index + last4
//     (task-002 helpers). DOB encrypted. Responses never echo raw SSN/DOB.
//   - Duplicate-SSN blind-index match on ANOTHER borrower's application creates a
//     duplicate-ssn FraudFlag and NEVER blocks the save (XBR-021 / INV-018).
//   - Every save: signature invalidation on data change (XBR-003/INV-029),
//     server-side DTI/LTV/CLTV recalc via the SHARED qualification module
//     persisted to Application.dti/ltv/cltv, staleness-advisory clearing
//     (edit or confirmCopiedSection — VR-068), audited section-saved with
//     masked before/after, versionStamp increment returned to the client.

import { Prisma, type WorkflowState } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { requireBorrowerOwnedAction } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { createFraudFlagsInTx } from "@/lib/services/fraud";
import { encryptField, encryptFieldToJson, isJsonEncryptedEnvelope } from "@/lib/crypto/encryption";
import { ssnBlindIndex, ssnLast4 } from "@/lib/crypto/ssn";
import { withServerGeocode } from "@/lib/services/geocoding";
import { invalidateSignaturesOnDataChange } from "@/lib/services/signature-validity";
import { computeApplicationQualification } from "@/lib/services/qualification";
import { buildValidationInput } from "@/lib/services/application";
import {
  serializeApplicationData,
  serializeBorrower,
  staleCopyAdvisoryEntries,
  staleCopyAdvisoryMessages,
} from "@/lib/services/application-serializer";
import { isBorrowerEditableState } from "@/lib/pure/workflow";
import { issuesForSection, PER_BORROWER_SECTIONS } from "@/lib/pure/urla-validation";
import type { SectionSaveRequest } from "@/lib/schemas/application";
import { SECTION_PAYLOAD_FIELDS, type WizardSectionValue } from "@/lib/schemas/application";

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function withRowIds<T extends Row>(rows: readonly T[] | undefined): Row[] | undefined {
  if (rows === undefined) return undefined;
  return rows.map((r) => ({ ...r, id: typeof r.id === "string" ? r.id : randomUUID() }));
}

function accountLast4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  return (digits.length >= 4 ? digits : accountNumber).slice(-4);
}

/**
 * Encrypt/preserve account numbers on a row array. A provided plaintext
 * `accountNumber` is replaced by the embedded AES-256-GCM envelope + last4; an
 * omitted one preserves the stored envelope of the row with the same id.
 */
function sealAccountNumbers(rows: Row[] | undefined, existing: unknown): Row[] | undefined {
  if (rows === undefined) return undefined;
  const existingById = new Map<string, Row>();
  if (Array.isArray(existing)) {
    for (const row of existing) {
      if (row !== null && typeof row === "object" && typeof (row as Row).id === "string") {
        existingById.set((row as Row).id as string, row as Row);
      }
    }
  }
  return rows.map((row) => {
    const out: Row = { ...row };
    const accountNumber = out.accountNumber;
    if (typeof accountNumber === "string" && accountNumber.length > 0) {
      out.accountNumber = encryptFieldToJson(accountNumber) as unknown;
      out.accountNumberLast4 = accountLast4(accountNumber);
    } else {
      delete out.accountNumber;
      const prev = existingById.get(out.id as string);
      if (prev && isJsonEncryptedEnvelope(prev.accountNumber)) {
        out.accountNumber = prev.accountNumber;
        if (typeof prev.accountNumberLast4 === "string") {
          out.accountNumberLast4 = prev.accountNumberLast4;
        }
      }
    }
    return out;
  });
}

/** REO rows: seal each row's mortgages (matched by REO row id, mortgage index). */
function sealReoRows(rows: Row[] | undefined, existing: unknown): Row[] | undefined {
  if (rows === undefined) return undefined;
  const existingById = new Map<string, Row>();
  if (Array.isArray(existing)) {
    for (const row of existing) {
      if (row !== null && typeof row === "object" && typeof (row as Row).id === "string") {
        existingById.set((row as Row).id as string, row as Row);
      }
    }
  }
  return rows.map((row) => {
    const out: Row = { ...row };
    const prev = existingById.get(out.id as string);
    const prevMortgages = Array.isArray(prev?.mortgages) ? (prev!.mortgages as Row[]) : [];
    if (Array.isArray(out.mortgages)) {
      out.mortgages = (out.mortgages as Row[]).map((m, i) => {
        const sealed: Row = { ...m };
        const accountNumber = sealed.accountNumber;
        if (typeof accountNumber === "string" && accountNumber.length > 0) {
          sealed.accountNumber = encryptFieldToJson(accountNumber) as unknown;
          sealed.accountNumberLast4 = accountLast4(accountNumber);
        } else {
          delete sealed.accountNumber;
          const prevM = prevMortgages[i];
          if (prevM && isJsonEncryptedEnvelope(prevM.accountNumber)) {
            sealed.accountNumber = prevM.accountNumber;
            if (typeof prevM.accountNumberLast4 === "string") {
              sealed.accountNumberLast4 = prevM.accountNumberLast4;
            }
          }
        }
        return sealed;
      });
    }
    return out;
  });
}

function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

// Masked audit views (never raw SSN/DOB/account numbers — SEC-8 posture).
const AUDIT_FIELDS_BY_SECTION: Record<WizardSectionValue, readonly string[]> = {
  identity: [
    "firstName", "middleName", "lastName", "suffix", "alternateNames", "ssnMasked",
    "dateOfBirthDisplay", "citizenship", "maritalStatus", "dependentsCount", "dependentsAges",
    "homePhone", "cellPhone", "workPhone", "workPhoneExt", "email", "creditType", "militaryService",
  ],
  "address-history": [
    "currentAddress", "housingStatus", "monthlyRent", "yearsAtAddress", "monthsAtAddress",
    "previousAddresses", "mailingAddress",
  ],
  "employment-income": ["employmentType", "employments", "previousEmployments", "otherIncome"],
  declarations: ["declarations"],
  demographics: ["demographics"],
  "assets-reo": ["assets", "otherCredits", "realEstateOwned"],
  liabilities: ["liabilities", "otherLiabilities"],
  "subject-property": ["subjectProperty"],
  // REQ-030: the Step-7 payload writes both the loan column and the
  // proposedHousingExpense group, so both belong in the before/after view.
  "loan-details": ["loan", "proposedHousingExpense"],
};

function pick(record: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!record) return out;
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

export interface SectionSaveResult {
  savedAt: string;
  versionStamp: number;
  dti?: number;
  ltv?: number;
  cltv?: number;
  issues: unknown[];
  signatureInvalidated?: boolean;
  staleCopyAdvisories?: string[];
}

export async function saveSection(
  user: SessionUser,
  applicationId: string,
  sectionParam: string,
  body: SectionSaveRequest,
  meta: RequestMetaBundle,
): Promise<SectionSaveResult> {
  // The URL segment and the body's section must agree (one section per call).
  if (sectionParam !== body.section) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: [`section: body section "${body.section}" does not match URL section "${sectionParam}"`],
    });
  }
  const section = body.section as WizardSectionValue;

  // INV-026 / task rule: owner only — 403 for any non-owner (incl. staff), 404 unknown.
  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-found") throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
    throw new HttpProblem(403, ERROR_CODES.forbidden, "Only the applying borrower may edit this application");
  }

  const isPerBorrower = (PER_BORROWER_SECTIONS as readonly string[]).includes(section);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: {
        id: true,
        applicationNumber: true,
        workflowState: true,
        versionStamp: true,
        staleCopyAdvisories: true,
      },
    });
    if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

    // §4.2.6: section saves only in Draft / Revision Requested.
    if (!isBorrowerEditableState(app.workflowState as WorkflowState)) {
      throw new HttpProblem(
        409,
        ERROR_CODES.conflict,
        "This application can no longer be edited in its current state",
        { currentState: app.workflowState },
      );
    }

    // INV-039 / REQ-035: stale stamp → 409 reload prompt, never a silent overwrite.
    if (app.versionStamp !== body.versionStamp) {
      throw new HttpProblem(
        409,
        ERROR_CODES.conflict,
        "This application was changed in another tab or session — reload to continue editing",
      );
    }

    let auditBefore: Record<string, unknown> = {};
    let auditAfter: Record<string, unknown> = {};
    let duplicateSsnFlagged = false;

    if (isPerBorrower) {
      const ordinal = body.borrowerOrdinal!; // schema enforces presence (VR-058)
      const borrower = await tx.borrower.findUnique({
        where: { applicationId_ordinal: { applicationId, ordinal } },
      });
      if (!borrower) {
        throw new HttpProblem(404, ERROR_CODES.notFound, `Borrower ${ordinal} not found on this application`);
      }
      auditBefore = pick(serializeBorrower(borrower), AUDIT_FIELDS_BY_SECTION[section]);

      const update: Prisma.BorrowerUncheckedUpdateInput = {};

      if (section === "identity") {
        const v = body.identity!;
        update.firstName = v.firstName ?? null;
        update.middleName = v.middleName ?? null;
        update.lastName = v.lastName ?? null;
        update.suffix = v.suffix ?? null;
        update.alternateNames = v.alternateNames ?? [];
        update.citizenship = v.citizenship ?? null;
        update.maritalStatus = v.maritalStatus ?? null;
        update.dependentsCount = v.dependentsCount ?? null;
        update.dependentsAges = v.dependentsAges ?? null;
        update.homePhone = v.homePhone ?? null;
        update.cellPhone = v.cellPhone ?? null;
        update.workPhone = v.workPhone ?? null;
        update.workPhoneExt = v.workPhoneExt ?? null;
        update.email = v.email ?? null;
        update.creditType = v.creditType ?? null;
        update.militaryService = json(v.militaryService);

        // Write-only secrets: omitted ⇒ unchanged (the client never holds them back).
        if (v.ssn !== undefined) {
          const sealed = encryptField(v.ssn);
          update.ssnCiphertext = new Uint8Array(sealed.ciphertext);
          update.ssnKeyId = sealed.keyId;
          update.ssnLast4 = ssnLast4(v.ssn);
          update.ssnBlindIndex = ssnBlindIndex(v.ssn);
        }
        if (v.dateOfBirth !== undefined) {
          const sealed = encryptField(v.dateOfBirth);
          update.dateOfBirthCiphertext = new Uint8Array(sealed.ciphertext);
          update.dateOfBirthKeyId = sealed.keyId;
        }
      } else if (section === "address-history") {
        const v = body.addressHistory!;
        update.currentAddress = json(v.currentAddress);
        update.housingStatus = v.housingStatus ?? null;
        update.monthlyRent = v.monthlyRent ?? null;
        update.yearsAtAddress = v.yearsAtAddress ?? null;
        update.monthsAtAddress = v.monthsAtAddress ?? null;
        update.previousAddresses = json(v.previousAddresses);
        // mailingAddressDifferent is a UI toggle; the stored fact is the address itself.
        update.mailingAddress = json(v.mailingAddressDifferent === false ? undefined : v.mailingAddress);
      } else if (section === "employment-income") {
        const v = body.employmentIncome!;
        update.employmentType = v.employmentType ?? null;
        update.employments = json(withRowIds(v.employments));
        update.previousEmployments = json(withRowIds(v.previousEmployments));
        update.otherIncome = json(withRowIds(v.otherIncome));
      } else if (section === "declarations") {
        update.declarations = json(body.declarations);
      } else {
        // demographics — DATA-003: electronic collection, never visual observation.
        const v = body.demographics!;
        update.demographics = json({
          ...v,
          collectionMethod: "email-or-internet",
          visualObservation: false,
        });
      }

      const updated = await tx.borrower.update({
        where: { id: borrower.id },
        data: update,
      });
      auditAfter = pick(serializeBorrower(updated), AUDIT_FIELDS_BY_SECTION[section]);

      // XBR-021 / INV-018: duplicate-SSN blind-index match on ANOTHER borrower's
      // application → FraudFlag; never blocks the save.
      if (section === "identity" && body.identity!.ssn !== undefined) {
        const blindIndex = ssnBlindIndex(body.identity!.ssn);
        const match = await tx.borrower.findFirst({
          where: {
            ssnBlindIndex: blindIndex,
            applicationId: { not: applicationId },
            application: { borrowerUserId: { not: user.userId } },
          },
          select: { id: true, applicationId: true },
        });
        if (match) {
          // task-027: creation goes through the shared fraud-engine creator so
          // dedup (open same-type), the REQ-060 in-tx creation audit, and the
          // §4.8.2 caseworker notification are uniform across all five
          // triggers. INV-018: JS-level evaluation failures are caught + logged
          // — never thrown into the save path.
          try {
            await createFraudFlagsInTx(tx as AuditTransactionClient, applicationId, [
              {
                type: "duplicate-ssn",
                severity: "high",
                details: `SSN ending ${ssnLast4(body.identity!.ssn)} entered for borrower ${ordinal} matches a borrower on another application (blind-index match).`,
              },
            ], { ip: meta.ip, requestId: meta.requestId });
          } catch (err) {
            console.error(
              `fraud: duplicate-SSN flag creation failed for application ${applicationId}`,
              err,
            );
          }
          duplicateSsnFlagged = true;
        }
      }
    } else {
      // Shared sections → ApplicationData upsert.
      const data = await tx.applicationData.findUnique({ where: { applicationId } });
      auditBefore = pick(serializeApplicationData(data), AUDIT_FIELDS_BY_SECTION[section]);

      const update: Prisma.ApplicationDataUncheckedUpdateInput = {};
      if (section === "assets-reo") {
        const v = body.assetsReo!;
        update.assets = json(sealAccountNumbers(withRowIds(v.assets), data?.assets));
        update.otherCredits = json(withRowIds(v.otherCredits));
        update.realEstateOwned = json(sealReoRows(withRowIds(v.realEstateOwned), data?.realEstateOwned));
      } else if (section === "liabilities") {
        const v = body.liabilities!;
        update.liabilities = json(sealAccountNumbers(withRowIds(v.liabilities), data?.liabilities));
        update.otherLiabilities = json(withRowIds(v.otherLiabilities));
      } else if (section === "subject-property") {
        // task-015 / §4.2.11: geocode is computed SERVER-side from the address
        // on every save (deterministic, fault-free) and stored into the
        // persisted SubjectProperty JSON for the AVM map (task-025) and HMDA
        // census tract (task-042). Any client-supplied geocode is discarded.
        update.subjectProperty = json(withServerGeocode(body.subjectProperty));
      } else {
        // loan-details — the Step-7 payload nests the contracted
        // `proposedHousingExpense` group (REQ-030), but §A ApplicationData
        // STORES it in its own top-level column (the single place the §E DTI
        // numerator reads it and the single path corrections address). Split
        // it off so the `loan` column never carries a second copy.
        const { proposedHousingExpense, ...loan } = body.loanDetails!;
        update.loan = json(loan);
        // Partial auto-save: an omitted group leaves the stored one untouched
        // (same rule as the write-only identity secrets above); a present one
        // REPLACES it, like every other section payload.
        if (proposedHousingExpense !== undefined) {
          update.proposedHousingExpense = json(proposedHousingExpense);
        }
      }

      const updated = await tx.applicationData.upsert({
        where: { applicationId },
        create: { applicationId, ...(update as object) } as Prisma.ApplicationDataUncheckedCreateInput,
        update,
      });
      auditAfter = pick(serializeApplicationData(updated), AUDIT_FIELDS_BY_SECTION[section]);
    }

    // REQ-022 / VR-068: an edit OR an explicit confirm clears the advisory.
    const advisories = staleCopyAdvisoryEntries(app.staleCopyAdvisories).filter(
      (a) => a.section !== section,
    );

    // XBR-003 / INV-029: any data edit invalidates signatures whose hash no longer matches.
    const signatureInvalidated = await invalidateSignaturesOnDataChange(tx, applicationId);

    // NFR-008 / SEC-7: server-side recalc via the SHARED module — the single implementation.
    const qualification = await computeApplicationQualification(applicationId, tx);

    // FT-74 / INV-039: the conditional update IS the race guard — versionStamp in
    // the WHERE clause; a concurrent committed save makes count 0 → 409.
    const updatedCount = await tx.application.updateMany({
      where: { id: applicationId, versionStamp: body.versionStamp },
      data: {
        versionStamp: { increment: 1 },
        dti: qualification.dti,
        ltv: qualification.ltv,
        cltv: qualification.cltv,
        staleCopyAdvisories: advisories as unknown as Prisma.InputJsonValue,
      },
    });
    if (updatedCount.count === 0) {
      throw new HttpProblem(
        409,
        ERROR_CODES.conflict,
        "This application was changed in another tab or session — reload to continue editing",
      );
    }

    // INV-036 / SEC-8: application-scoped audit in the SAME transaction.
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "section-saved",
      applicationId,
      entityType: "Application",
      entityId: applicationId,
      summary: `Section ${section}${isPerBorrower ? ` (borrower ${body.borrowerOrdinal})` : ""} saved on application ${app.applicationNumber}`,
      before: auditBefore as Prisma.InputJsonValue,
      after: auditAfter as Prisma.InputJsonValue,
      ip: meta.ip,
      requestId: meta.requestId,
    });

    // Per-section issues for the wizard (missing-required surface here, not as save errors).
    const validationInput = await buildValidationInput(tx, applicationId);
    const issues = issuesForSection(
      validationInput,
      section,
      isPerBorrower ? body.borrowerOrdinal : undefined,
    );

    const response: SectionSaveResult = {
      savedAt: now.toISOString(),
      versionStamp: body.versionStamp + 1,
      issues,
    };
    if (qualification.dti !== null) response.dti = qualification.dti;
    if (qualification.ltv !== null) response.ltv = qualification.ltv;
    if (qualification.cltv !== null) response.cltv = qualification.cltv;
    if (signatureInvalidated) response.signatureInvalidated = true;
    response.staleCopyAdvisories = staleCopyAdvisoryMessages(
      advisories as unknown as Prisma.JsonValue,
    );
    void duplicateSsnFlagged; // informational only — never blocks or changes the response (XBR-021)
    return response;
  });

  return result;
}
