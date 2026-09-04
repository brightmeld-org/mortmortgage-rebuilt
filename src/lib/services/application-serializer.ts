// Application wire-shape serializers (task-011) — the single projection from
// Prisma rows to the contracts.md §A shapes: Application, BorrowerRecord,
// SignatureInfo, VersionInfo, and the section-structured version snapshot.
//
// Masking guarantees (S-5 / SEC-1 / SEC-2, NFR-003):
//   - SSN egress here is ALWAYS ssnMasked (***-**-NNNN via the single masking
//     module) + ssnLast4. The full SSN leaves the server ONLY on the owner
//     identity endpoint, which deliberately does NOT use this serializer.
//   - DOB egress here is ALWAYS dateOfBirthDisplay ("Mon D, YYYY"); raw ISO DOB
//     never appears.
//   - Account-number encryption envelopes embedded in ApplicationData JSON are
//     STRIPPED; only accountNumberLast4 fields pass through.
//   - Staff appear as display names only (assignedCaseworkerName — S-6).
//
// Serializers are live projections of the rows they are handed — every field is
// derived from row data (live-state rule), never defaulted.

import type { Prisma } from "@prisma/client";
import type {
  Application,
  ApplicationData,
  ApplicationVersion,
  Borrower,
  Signature,
  UserRole,
} from "@prisma/client";
import { decryptField, isJsonEncryptedEnvelope } from "@/lib/crypto/encryption";
import { formatDobDisplay, maskSsn } from "@/lib/crypto/masking";
import { availableTransitionsForOutcome, workflowStateLabel } from "@/lib/pure/workflow";

// ---------------------------------------------------------------------------
// JSON masking helpers
// ---------------------------------------------------------------------------

/**
 * Deep-strip embedded encryption envelopes from an ApplicationData JSON
 * document: any { __enc, keyId, ciphertext } value is REMOVED (the sibling
 * *Last4 field remains the only account-number signal on the wire).
 */
export function stripEncryptedEnvelopes(value: Prisma.JsonValue | null): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripEncryptedEnvelopes(v));
  const record = value as Record<string, Prisma.JsonValue>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(record)) {
    if (isJsonEncryptedEnvelope(v)) continue; // never serialize ciphertext
    out[key] = stripEncryptedEnvelopes(v);
  }
  return out;
}

function decimalToNumber(value: Prisma.Decimal | null): number | undefined {
  return value === null ? undefined : Number(value);
}

// ---------------------------------------------------------------------------
// BorrowerRecord (§A) — masked projection
// ---------------------------------------------------------------------------

export function serializeBorrower(row: Borrower): Record<string, unknown> {
  const dateOfBirthIso =
    row.dateOfBirthCiphertext && row.dateOfBirthKeyId
      ? decryptField({ ciphertext: row.dateOfBirthCiphertext, keyId: row.dateOfBirthKeyId })
      : null;

  return {
    id: row.id,
    applicationId: row.applicationId,
    ordinal: row.ordinal,
    firstName: row.firstName ?? undefined,
    middleName: row.middleName ?? undefined,
    lastName: row.lastName ?? undefined,
    suffix: row.suffix ?? undefined,
    alternateNames: row.alternateNames.length > 0 ? row.alternateNames : undefined,
    ssnMasked: row.ssnLast4 ? maskSsn(row.ssnLast4) : undefined,
    ssnLast4: row.ssnLast4 ?? undefined,
    dateOfBirthDisplay: dateOfBirthIso ? formatDobDisplay(dateOfBirthIso) : undefined,
    citizenship: row.citizenship ?? undefined,
    maritalStatus: row.maritalStatus ?? undefined,
    dependentsCount: row.dependentsCount ?? undefined,
    dependentsAges: row.dependentsAges ?? undefined,
    homePhone: row.homePhone ?? undefined,
    cellPhone: row.cellPhone ?? undefined,
    workPhone: row.workPhone ?? undefined,
    workPhoneExt: row.workPhoneExt ?? undefined,
    email: row.email ?? undefined,
    creditType: row.creditType ?? undefined,
    militaryService: row.militaryService ?? undefined,
    currentAddress: row.currentAddress ?? undefined,
    housingStatus: row.housingStatus ?? undefined,
    monthlyRent: row.monthlyRent === null ? undefined : Number(row.monthlyRent),
    yearsAtAddress: row.yearsAtAddress ?? undefined,
    monthsAtAddress: row.monthsAtAddress ?? undefined,
    previousAddresses: row.previousAddresses ?? undefined,
    mailingAddress: row.mailingAddress ?? undefined,
    employmentType: row.employmentType ?? undefined,
    employments: stripEncryptedEnvelopes(row.employments) ?? undefined,
    previousEmployments: row.previousEmployments ?? undefined,
    otherIncome: row.otherIncome ?? undefined,
    declarations: row.declarations ?? undefined,
    demographics: row.demographics ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// ApplicationData (§A) — envelopes stripped
// ---------------------------------------------------------------------------

export function serializeApplicationData(row: ApplicationData | null): Record<string, unknown> | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  const put = (key: string, value: Prisma.JsonValue | null) => {
    if (value !== null) out[key] = stripEncryptedEnvelopes(value);
  };
  put("assets", row.assets);
  put("otherCredits", row.otherCredits);
  put("realEstateOwned", row.realEstateOwned);
  put("liabilities", row.liabilities);
  put("otherLiabilities", row.otherLiabilities);
  put("subjectProperty", row.subjectProperty);
  put("loan", row.loan);
  put("proposedHousingExpense", row.proposedHousingExpense);
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// SignatureInfo (§A)
// ---------------------------------------------------------------------------

export function serializeSignature(row: Signature): Record<string, unknown> {
  return {
    id: row.id,
    borrowerId: row.borrowerId,
    mode: row.mode,
    signedAt: row.signedAt.toISOString(),
    attestationVersion: row.attestationVersion ?? undefined,
    invalidatedAt: row.invalidatedAt ? row.invalidatedAt.toISOString() : undefined,
    demoBypass: row.demoBypass ? true : undefined,
  };
}

// ---------------------------------------------------------------------------
// BankLinkInfo (§A, CH-018 / REQ-039 / BUG-28)
// ---------------------------------------------------------------------------

/**
 * The ONLY BankLink columns allowed on the wire. The access-token envelope
 * (accessTokenCiphertext / accessTokenKeyId) is deliberately absent from this
 * shape AND from the `select` below, so token material cannot be serialized
 * even by accident (§4.2.10 "link tokens are stored encrypted", XBR-019).
 */
export type BankLinkWireRow = {
  id: string;
  institution: string;
  linkedAt: Date;
  importedAccountIds: string[];
};

/** contracts §A BankLinkInfo — the carrier of the `:linkId` the UI unlinks by. */
export function serializeBankLink(row: BankLinkWireRow): Record<string, unknown> {
  return {
    id: row.id,
    institution: row.institution,
    linkedAt: row.linkedAt.toISOString(),
    importedAccountCount: row.importedAccountIds.length,
  };
}

// ---------------------------------------------------------------------------
// Application (§A) — full wire shape
// ---------------------------------------------------------------------------

/** Row shape serializeApplication needs (findUnique with these includes). */
export type ApplicationWithRelations = Application & {
  borrowers: Borrower[];
  data: ApplicationData | null;
  signatures: Signature[];
  assignments?: {
    caseworkerUser: { firstName: string; lastName: string };
  }[];
  bankLinks?: BankLinkWireRow[];
};

export const APPLICATION_INCLUDE = {
  borrowers: { orderBy: { ordinal: "asc" as const } },
  data: true,
  signatures: { orderBy: { signedAt: "asc" as const }, take: 50 },
  assignments: {
    where: { endedAt: null },
    select: { caseworkerUser: { select: { firstName: true, lastName: true } } },
    take: 1,
  },
  // CH-018: Application.bankLinks carries ACTIVE links only (unlinkedAt null) —
  // an unlinked link is ABSENT from the wire, never tombstoned. Included in the
  // one detail query (no extra round trip per application); the token columns
  // are excluded by the `select`.
  bankLinks: {
    where: { unlinkedAt: null },
    orderBy: { linkedAt: "asc" as const },
    select: { id: true, institution: true, linkedAt: true, importedAccountIds: true },
  },
} satisfies Prisma.ApplicationInclude;

/**
 * Serialize to the §A Application wire shape for the given caller role.
 * availableTransitions is computed from the shared static map for the CALLER's
 * role (§A: "toState machine names valid for the current state and caller role").
 */
export function serializeApplication(
  row: ApplicationWithRelations,
  callerRole: UserRole,
): Record<string, unknown> {
  const activeAssignment = row.assignments?.[0];
  const assignedCaseworkerName = activeAssignment
    ? `${activeAssignment.caseworkerUser.firstName} ${activeAssignment.caseworkerUser.lastName}`.trim()
    : undefined;

  const advisories = staleCopyAdvisoryEntries(row.staleCopyAdvisories);

  return {
    id: row.id,
    applicationNumber: row.applicationNumber,
    borrowerUserId: row.borrowerUserId,
    workflowState: row.workflowState,
    workflowStateLabel: workflowStateLabel(row.workflowState),
    previousStateForSuspend: row.previousStateForSuspend ?? undefined,
    priority: row.priority,
    priorityOverride: row.priorityOverride ? true : undefined,
    currentVersionNumber: row.currentVersionNumber,
    versionStamp: row.versionStamp,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : undefined,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : undefined,
    outcome: row.outcome ?? undefined,
    stateEnteredAt: row.stateEnteredAt.toISOString(),
    slaPausedAt: row.slaPausedAt ? row.slaPausedAt.toISOString() : undefined,
    // slaStatus / overallSlaDaysRemaining: computed fields, merged in by the
    // async task-021 enrichment (src/lib/services/sla.ts withSlaFields) after
    // this sync serializer runs; absent for drafts (no clock before submission).
    revisionCycles: row.revisionCycles,
    escalationRequired: row.escalationRequired ? true : undefined,
    escalationCriteriaMet: row.escalationCriteriaMet.length > 0 ? row.escalationCriteriaMet : undefined,
    dti: decimalToNumber(row.dti),
    ltv: decimalToNumber(row.ltv),
    cltv: decimalToNumber(row.cltv),
    ausStale: row.ausStale ? true : undefined,
    isSeed: row.isSeed ? true : undefined,
    copiedFromApplicationId: row.copiedFromApplicationId ?? undefined,
    assignedCaseworkerName,
    decisionNotificationPending: row.decisionNotificationPending ? true : undefined,
    borrowers: row.borrowers.map((b) => serializeBorrower(b)),
    data: serializeApplicationData(row.data),
    signatures: row.signatures.length > 0 ? row.signatures.map((s) => serializeSignature(s)) : undefined,
    // CH-018 (REQ-039): active bank links, so the borrower can address
    // DELETE /api/applications/:id/bank-links/:linkId after a page reload.
    bankLinks:
      row.bankLinks && row.bankLinks.length > 0
        ? row.bankLinks.map((link) => serializeBankLink(link))
        : undefined,
    // Outcome-aware (INV-022/INV-033, task-019): borrower_notified with
    // outcome=denied is terminal — no transitions offered.
    availableTransitions: availableTransitionsForOutcome(row.workflowState, callerRole, row.outcome),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Stale-copy advisories (REQ-022) — stored JSON column helpers
// ---------------------------------------------------------------------------

/** Stored advisory entry ({ section, sourceSavedAt, message }). */
export interface StaleCopyAdvisoryEntry {
  section: string;
  sourceSavedAt: string;
  message: string;
}

export function staleCopyAdvisoryEntries(value: Prisma.JsonValue): StaleCopyAdvisoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: StaleCopyAdvisoryEntry[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.section === "string" && typeof rec.message === "string") {
      out.push({
        section: rec.section,
        sourceSavedAt: typeof rec.sourceSavedAt === "string" ? rec.sourceSavedAt : "",
        message: rec.message,
      });
    }
  }
  return out;
}

/** Wire form: SectionSaveResponse.staleCopyAdvisories is the message strings. */
export function staleCopyAdvisoryMessages(value: Prisma.JsonValue): string[] {
  return staleCopyAdvisoryEntries(value).map((e) => e.message);
}

// ---------------------------------------------------------------------------
// VersionInfo (§A) + the section-structured version snapshot
// ---------------------------------------------------------------------------

export function serializeVersionInfo(
  row: ApplicationVersion,
  currentVersionNumber: number,
): Record<string, unknown> {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    isCurrent: row.versionNumber === currentVersionNumber,
  };
}

/**
 * The immutable ApplicationVersion snapshot (INV-008), organized BY URLA SECTION
 * so the §A version diff groups naturally. Masked-only content: borrowers carry
 * ssnMasked + dateOfBirthDisplay (never raw SSN/ISO DOB), account numbers carry
 * last4 only — safe for any reader of versions/diffs.
 */
export function buildVersionSnapshot(row: ApplicationWithRelations): Prisma.InputJsonValue {
  const data = row.data;
  const borrowers = row.borrowers.map((b) => {
    const wire = serializeBorrower(b);
    return {
      ordinal: b.ordinal,
      identity: pick(wire, [
        "firstName",
        "middleName",
        "lastName",
        "suffix",
        "alternateNames",
        "ssnMasked",
        "dateOfBirthDisplay",
        "citizenship",
        "maritalStatus",
        "dependentsCount",
        "dependentsAges",
        "homePhone",
        "cellPhone",
        "workPhone",
        "workPhoneExt",
        "email",
        "creditType",
        "militaryService",
      ]),
      "address-history": pick(wire, [
        "currentAddress",
        "housingStatus",
        "monthlyRent",
        "yearsAtAddress",
        "monthsAtAddress",
        "previousAddresses",
        "mailingAddress",
      ]),
      "employment-income": pick(wire, [
        "employmentType",
        "employments",
        "previousEmployments",
        "otherIncome",
      ]),
      declarations: (wire.declarations as Record<string, unknown> | undefined) ?? {},
      demographics: (wire.demographics as Record<string, unknown> | undefined) ?? {},
    };
  });

  return {
    snapshotVersion: 1,
    applicationNumber: row.applicationNumber,
    borrowers,
    "assets-reo": {
      assets: strippedOrEmpty(data?.assets),
      otherCredits: strippedOrEmpty(data?.otherCredits),
      realEstateOwned: strippedOrEmpty(data?.realEstateOwned),
    },
    liabilities: {
      liabilities: strippedOrEmpty(data?.liabilities),
      otherLiabilities: strippedOrEmpty(data?.otherLiabilities),
    },
    "subject-property": (stripEncryptedEnvelopes(data?.subjectProperty ?? null) ?? {}) as Record<
      string,
      unknown
    >,
    "loan-details": {
      ...((stripEncryptedEnvelopes(data?.loan ?? null) ?? {}) as Record<string, unknown>),
      proposedHousingExpense:
        (stripEncryptedEnvelopes(data?.proposedHousingExpense ?? null) as Record<string, unknown> | null) ??
        undefined,
    },
    dti: decimalToNumber(row.dti) ?? null,
    ltv: decimalToNumber(row.ltv) ?? null,
    cltv: decimalToNumber(row.cltv) ?? null,
  } as unknown as Prisma.InputJsonValue;
}

function strippedOrEmpty(value: Prisma.JsonValue | null | undefined): unknown[] {
  const stripped = stripEncryptedEnvelopes(value ?? null);
  return Array.isArray(stripped) ? stripped : [];
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}
