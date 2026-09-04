// Signature data-hash authority + invalidation-on-edit (task-011).
//
// XBR-003 / INV-029: a signature is valid only while the hash of the signed
// application-data snapshot matches CURRENT application data. This module is the
// SINGLE hash authority:
//   - computeApplicationDataHash(tx, applicationId) — deterministic canonical
//     SHA-256 over all application data + borrower rows. task-012 (signature
//     capture) MUST call this same function to stamp Signature.dataHash; task-019
//     (T1/T36 gate) compares live hash to each signature's dataHash.
//   - invalidateSignaturesOnDataChange(tx, applicationId) — called by every
//     data-mutating path (section save, co-borrower add/remove, corrections) IN
//     THE SAME TRANSACTION as the change: active signatures whose dataHash no
//     longer matches get invalidatedAt set.
//
// CANONICALIZATION (deterministic by construction):
//   - JSON with recursively SORTED object keys; arrays keep their order.
//   - Volatile / representation-unstable fields are EXCLUDED: row ids,
//     createdAt/updatedAt, versionStamp, and every ciphertext column (AES-GCM
//     output differs per write for identical plaintext — hashing it would
//     invalidate signatures on no-op re-encryption).
//   - SSN enters via its deterministic HMAC blind index (same SSN ⇒ same index);
//     DOB enters as the DECRYPTED ISO date. Account numbers inside ApplicationData
//     JSON enter via their stored last4 (the embedded __enc envelopes are
//     replaced by { last4 } before hashing).
//   - Borrower rows are ordered by ordinal; the hash input embeds a version tag
//     so a future canonicalization change cannot silently collide.

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuditTransactionClient } from "@/lib/services/audit";
import { createNotification } from "@/lib/services/notifications";
import { decryptField, isJsonEncryptedEnvelope } from "@/lib/crypto/encryption";

/** Read paths accept either client; the WRITE path (invalidation) is tx-only. */
export type SignatureDbClient = PrismaClient | Prisma.TransactionClient;

const HASH_VERSION = "mm-datahash-v1";

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

type JsonLike = unknown;

/**
 * Recursively canonicalize a JSON value: object keys sorted, undefined dropped,
 * embedded encryption envelopes replaced by their deterministic surrogate.
 */
export function canonicalize(value: JsonLike): JsonLike {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (isJsonEncryptedEnvelope(value)) {
    // Non-deterministic ciphertext — replaced by a stable marker; the sibling
    // accountNumberLast4 field carries the deterministic content signal.
    return { __enc: true };
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** Stable stringify of a canonicalized value. */
export function canonicalStringify(value: JsonLike): string {
  return JSON.stringify(canonicalize(value));
}

// ---------------------------------------------------------------------------
// The hash
// ---------------------------------------------------------------------------

/** Borrower fields that enter the hash (data content only — see module header). */
function borrowerHashView(b: {
  ordinal: number;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
  alternateNames: string[];
  ssnBlindIndex: string | null;
  dateOfBirthCiphertext: Uint8Array | null;
  dateOfBirthKeyId: string | null;
  citizenship: string | null;
  maritalStatus: string | null;
  dependentsCount: number | null;
  dependentsAges: string | null;
  homePhone: string | null;
  cellPhone: string | null;
  workPhone: string | null;
  workPhoneExt: string | null;
  email: string | null;
  creditType: string | null;
  militaryService: Prisma.JsonValue;
  currentAddress: Prisma.JsonValue;
  housingStatus: string | null;
  monthlyRent: Prisma.Decimal | null;
  yearsAtAddress: number | null;
  monthsAtAddress: number | null;
  previousAddresses: Prisma.JsonValue;
  mailingAddress: Prisma.JsonValue;
  employmentType: string | null;
  employments: Prisma.JsonValue;
  previousEmployments: Prisma.JsonValue;
  otherIncome: Prisma.JsonValue;
  declarations: Prisma.JsonValue;
  demographics: Prisma.JsonValue;
}): Record<string, unknown> {
  const dateOfBirth =
    b.dateOfBirthCiphertext && b.dateOfBirthKeyId
      ? decryptField({ ciphertext: b.dateOfBirthCiphertext, keyId: b.dateOfBirthKeyId })
      : null;
  return {
    ordinal: b.ordinal,
    firstName: b.firstName,
    middleName: b.middleName,
    lastName: b.lastName,
    suffix: b.suffix,
    alternateNames: b.alternateNames,
    // Deterministic SSN surrogate (same SSN in any formatting ⇒ same index).
    ssnBlindIndex: b.ssnBlindIndex,
    dateOfBirth,
    citizenship: b.citizenship,
    maritalStatus: b.maritalStatus,
    dependentsCount: b.dependentsCount,
    dependentsAges: b.dependentsAges,
    homePhone: b.homePhone,
    cellPhone: b.cellPhone,
    workPhone: b.workPhone,
    workPhoneExt: b.workPhoneExt,
    email: b.email,
    creditType: b.creditType,
    militaryService: b.militaryService,
    currentAddress: b.currentAddress,
    housingStatus: b.housingStatus,
    monthlyRent: b.monthlyRent === null ? null : b.monthlyRent.toString(),
    yearsAtAddress: b.yearsAtAddress,
    monthsAtAddress: b.monthsAtAddress,
    previousAddresses: b.previousAddresses,
    mailingAddress: b.mailingAddress,
    employmentType: b.employmentType,
    employments: b.employments,
    previousEmployments: b.previousEmployments,
    otherIncome: b.otherIncome,
    declarations: b.declarations,
    demographics: b.demographics,
  };
}

/**
 * THE application data hash (XBR-003 / INV-029 single authority; task-012 reuses
 * this for signature capture). Runs on the caller's transaction client so
 * save + hash + invalidation are one atomic unit.
 */
export async function computeApplicationDataHash(
  tx: SignatureDbClient,
  applicationId: string,
): Promise<string> {
  const borrowers = await tx.borrower.findMany({
    where: { applicationId },
    orderBy: { ordinal: "asc" },
    take: 2, // INV-035: at most 2 borrower rows
  });
  const data = await tx.applicationData.findUnique({ where: { applicationId } });

  const view = {
    version: HASH_VERSION,
    borrowers: borrowers.map((b) => borrowerHashView(b)),
    data: data
      ? {
          assets: data.assets,
          otherCredits: data.otherCredits,
          realEstateOwned: data.realEstateOwned,
          liabilities: data.liabilities,
          otherLiabilities: data.otherLiabilities,
          subjectProperty: data.subjectProperty,
          loan: data.loan,
          proposedHousingExpense: data.proposedHousingExpense,
        }
      : null,
  };

  return createHash("sha256").update(canonicalStringify(view), "utf8").digest("hex");
}

/**
 * XBR-003 / INV-029: after ANY application-data change (same transaction),
 * invalidate every ACTIVE signature whose signed dataHash no longer matches the
 * current data hash. Returns true when at least one signature was invalidated
 * (SectionSaveResponse.signatureInvalidated).
 */
export async function invalidateSignaturesOnDataChange(
  tx: AuditTransactionClient,
  applicationId: string,
): Promise<boolean> {
  const currentHash = await computeApplicationDataHash(tx, applicationId);
  const result = await tx.signature.updateMany({
    where: {
      applicationId,
      invalidatedAt: null,
      dataHash: { not: currentHash },
    },
    data: { invalidatedAt: new Date() },
  });

  if (result.count > 0) {
    // §4.8.2 borrower trigger "signature invalidated by edit" (task-036):
    // this function is the SINGLE invalidation point (section save,
    // co-borrower add/remove, corrections), so the notification is wired here
    // once — via THE notification service, in the same transaction.
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: { borrowerUserId: true, applicationNumber: true },
    });
    if (app) {
      await createNotification(tx, {
        recipientUserId: app.borrowerUserId,
        type: "signature-invalidated",
        title: "Signatures invalidated by an edit",
        body: `Application data on ${app.applicationNumber} changed after signing, so the existing signature(s) are no longer valid. Every borrower must re-sign before submission.`,
        applicationId,
      });
    }
  }
  return result.count > 0;
}

/**
 * Live signature-validity check (INV-029, used by the submission gate): the
 * ordinals of borrowers holding a CURRENTLY-VALID signature — invalidatedAt null
 * AND dataHash equal to the current data hash.
 */
export async function currentlySignedOrdinals(
  tx: SignatureDbClient,
  applicationId: string,
): Promise<number[]> {
  const currentHash = await computeApplicationDataHash(tx, applicationId);
  const signatures = await tx.signature.findMany({
    where: { applicationId, invalidatedAt: null, dataHash: currentHash },
    select: { borrower: { select: { ordinal: true } } },
    take: 50,
  });
  return [...new Set(signatures.map((s) => s.borrower.ordinal))];
}
