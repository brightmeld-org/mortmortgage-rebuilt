// UrlaWizard (task-016) — draft model + wire payload builders.
//
// The wizard holds ONE draft object mirroring the SectionSaveRequest section
// payloads. `build*Payload` functions sanitize the draft into payloads that
// satisfy the server's STRICT zod schemas (src/lib/schemas/application.ts):
//   - rows missing wire-required minimums (e.g. a previous-employment row
//     without valid start/end dates) are withheld from the wire but retained in
//     the draft + local buffer until they become valid;
//   - empty-string optionals are omitted; malformed dates/ssn/emails are
//     withheld (submission requiredness is the server validation engine's job,
//     not the save path's).
// Live-state rule: the draft is initialized ONLY from the loaded Application +
// identity-own responses — nothing is hardcoded.

import type {
  Address,
  AddressHistorySection,
  Application,
  AssetsSection,
  BorrowerIdentitySection,
  BorrowerRecord,
  Declarations,
  Demographics,
  EmploymentSection,
  LiabilitiesSection,
  LoanDetailsSection,
  SubjectProperty,
} from "./types";

// ---------------------------------------------------------------------------
// Draft model
// ---------------------------------------------------------------------------

export interface BorrowerDraft {
  identity: BorrowerIdentitySection;
  addressHistory: AddressHistorySection;
  employmentIncome: EmploymentSection;
  declarations: Declarations;
  demographics: Demographics;
}

export interface WizardDraft {
  borrowers: Record<number, BorrowerDraft>;
  assetsReo: AssetsSection;
  liabilities: LiabilitiesSection;
  subjectProperty: SubjectProperty;
  loanDetails: LoanDetailsSection;
}

export const EMPTY_ADDRESS: Address = { street: "", city: "", state: "", zip: "" };

export function emptyBorrowerDraft(email?: string): BorrowerDraft {
  return {
    identity: { email: email || undefined, militaryService: { served: false } },
    addressHistory: { currentAddress: { ...EMPTY_ADDRESS }, previousAddresses: [] },
    employmentIncome: { employments: [], previousEmployments: [], otherIncome: [] },
    declarations: {},
    demographics: { ethnicity: [], race: [], raceOtherDetails: [] },
  };
}

/** Build the borrower draft from the BorrowerRecord (masked GET projection). */
export function borrowerDraftFromRecord(b: BorrowerRecord): BorrowerDraft {
  return {
    identity: {
      firstName: b.firstName,
      middleName: b.middleName,
      lastName: b.lastName,
      suffix: b.suffix,
      alternateNames: b.alternateNames ?? [],
      // ssn / dateOfBirth arrive from the identity-own endpoint (unmasked write
      // values); merged in by the caller.
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
      militaryService: b.militaryService ?? { served: false },
    },
    addressHistory: {
      currentAddress: b.currentAddress ?? { ...EMPTY_ADDRESS },
      housingStatus: b.housingStatus,
      monthlyRent: b.monthlyRent,
      yearsAtAddress: b.yearsAtAddress,
      monthsAtAddress: b.monthsAtAddress,
      previousAddresses: b.previousAddresses ?? [],
      mailingAddressDifferent: b.mailingAddress !== undefined,
      mailingAddress: b.mailingAddress,
    },
    employmentIncome: {
      employmentType: b.employmentType,
      employments: b.employments ?? [],
      previousEmployments: b.previousEmployments ?? [],
      otherIncome: b.otherIncome ?? [],
    },
    declarations: b.declarations ?? {},
    demographics: b.demographics ?? { ethnicity: [], race: [], raceOtherDetails: [] },
  };
}

/** Build the full draft from a loaded Application (shared sections). */
export function draftFromApplication(app: Application): WizardDraft {
  const borrowers: Record<number, BorrowerDraft> = {};
  for (const b of app.borrowers) borrowers[b.ordinal] = borrowerDraftFromRecord(b);
  const data = app.data ?? {};
  return {
    borrowers,
    assetsReo: {
      assets: data.assets ?? [],
      otherCredits: data.otherCredits ?? [],
      realEstateOwned: data.realEstateOwned ?? [],
    },
    liabilities: {
      liabilities: data.liabilities ?? [],
      otherLiabilities: data.otherLiabilities ?? [],
    },
    subjectProperty: data.subjectProperty ?? { address: { ...EMPTY_ADDRESS } },
    loanDetails: {
      ...(data.loan ?? {}),
      // Contract delta: the wire payload NESTS the group; storage keeps it at
      // ApplicationData.proposedHousingExpense.
      proposedHousingExpense: data.proposedHousingExpense ?? {},
    },
  };
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SSN = /^\d{3}-\d{2}-\d{4}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function num(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function nonNeg(v: number | undefined): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

function isoDate(v: string | undefined): string | undefined {
  return v && ISO_DATE.test(v) ? v : undefined;
}

function cleanRecord<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** Address wire shape: street/city/state/zip PRESENT (may be empty strings while drafting). */
function cleanAddress(a: Address | undefined): Address | undefined {
  if (!a) return undefined;
  return cleanRecord({
    street: a.street ?? "",
    unit: str(a.unit),
    city: a.city ?? "",
    state: a.state ?? "",
    zip: a.zip ?? "",
    county: str(a.county),
    country: str(a.country),
  });
}

/** Include an address only when the user actually entered something. */
function addressIfTouched(a: Address | undefined): Address | undefined {
  const c = cleanAddress(a);
  if (!c) return undefined;
  const touched = [c.street, c.unit, c.city, c.state, c.zip, c.county, c.country].some(
    (p) => typeof p === "string" && p.trim() !== "",
  );
  return touched ? c : undefined;
}

// ---------------------------------------------------------------------------
// Per-section wire payload builders
// ---------------------------------------------------------------------------

export function buildIdentityPayload(d: BorrowerIdentitySection): Record<string, unknown> {
  const ms = d.militaryService;
  return cleanRecord({
    firstName: str(d.firstName),
    middleName: str(d.middleName),
    lastName: str(d.lastName),
    suffix: str(d.suffix),
    alternateNames:
      d.alternateNames && d.alternateNames.filter((n) => n.trim() !== "").length > 0
        ? d.alternateNames.filter((n) => n.trim() !== "")
        : undefined,
    ssn: d.ssn && SSN.test(d.ssn) ? d.ssn : undefined,
    dateOfBirth: isoDate(d.dateOfBirth),
    citizenship: str(d.citizenship),
    maritalStatus: str(d.maritalStatus),
    dependentsCount: num(d.dependentsCount),
    dependentsAges: str(d.dependentsAges),
    homePhone: str(d.homePhone),
    cellPhone: str(d.cellPhone),
    workPhone: str(d.workPhone),
    workPhoneExt: str(d.workPhoneExt),
    email: d.email && EMAIL.test(d.email.trim()) ? d.email.trim() : undefined,
    creditType: str(d.creditType),
    militaryService: ms
      ? cleanRecord({
          served: ms.served === true,
          status: ms.served ? str(ms.status) : undefined,
          projectedExpirationDate: ms.served ? isoDate(ms.projectedExpirationDate) : undefined,
        })
      : undefined,
  });
}

export function buildAddressHistoryPayload(d: AddressHistorySection): Record<string, unknown> {
  return cleanRecord({
    currentAddress: cleanAddress(d.currentAddress),
    housingStatus: str(d.housingStatus),
    monthlyRent: nonNeg(d.monthlyRent),
    yearsAtAddress: num(d.yearsAtAddress),
    monthsAtAddress: num(d.monthsAtAddress),
    previousAddresses: (d.previousAddresses ?? [])
      .map((p) =>
        cleanRecord({
          address: cleanAddress(p.address) ?? { ...EMPTY_ADDRESS },
          housingStatus: str(p.housingStatus),
          yearsAtAddress: num(p.yearsAtAddress),
          monthsAtAddress: num(p.monthsAtAddress),
          // VR-132 interval endpoints (optional).
          fromDate: isoDate(p.fromDate),
          toDate: isoDate(p.toDate),
        }),
      ),
    mailingAddressDifferent: d.mailingAddressDifferent === true ? true : d.mailingAddressDifferent === false ? false : undefined,
    mailingAddress: d.mailingAddressDifferent ? addressIfTouched(d.mailingAddress) : undefined,
  });
}

export function buildEmploymentPayload(d: EmploymentSection): Record<string, unknown> {
  return cleanRecord({
    employmentType: str(d.employmentType),
    employments: (d.employments ?? []).map((e) =>
      cleanRecord({
        id: e.id,
        employerName: e.employerName ?? "",
        employerAddress: addressIfTouched(e.employerAddress),
        employerPhone: str(e.employerPhone),
        position: str(e.position),
        startDate: isoDate(e.startDate),
        yearsInLineOfWork: nonNeg(e.yearsInLineOfWork),
        selfEmployed: e.selfEmployed === true,
        ownershipShareGte25: e.ownershipShareGte25,
        employedByFamilyOrParty: e.employedByFamilyOrParty,
        baseMonthlyIncome: nonNeg(e.baseMonthlyIncome),
        overtime: nonNeg(e.overtime),
        bonus: nonNeg(e.bonus),
        commission: nonNeg(e.commission),
        militaryEntitlements: nonNeg(e.militaryEntitlements),
        otherMonthlyIncome: nonNeg(e.otherMonthlyIncome),
        // Loss (negative) permitted here only (INV-025).
        selfEmployedMonthlyIncome: num(e.selfEmployedMonthlyIncome),
      }),
    ),
    // Wire requires valid start/end dates; incomplete rows stay draft-local.
    previousEmployments: (d.previousEmployments ?? [])
      .filter((p) => isoDate(p.startDate) && isoDate(p.endDate))
      .map((p) =>
        cleanRecord({
          id: p.id,
          employerName: p.employerName ?? "",
          employerAddress: addressIfTouched(p.employerAddress),
          position: str(p.position),
          startDate: p.startDate,
          endDate: p.endDate,
          previousGrossMonthlyIncome: nonNeg(p.previousGrossMonthlyIncome),
        }),
      ),
    // Wire requires source + monthlyAmount; incomplete rows stay draft-local.
    otherIncome: (d.otherIncome ?? [])
      .filter((o) => str(o.source) && nonNeg(o.monthlyAmount) !== undefined)
      .map((o) => cleanRecord({ id: o.id, source: o.source, monthlyAmount: o.monthlyAmount })),
  });
}

export function buildAssetsPayload(d: AssetsSection): Record<string, unknown> {
  return cleanRecord({
    assets: (d.assets ?? [])
      .filter((a) => str(a.accountType))
      .map((a) =>
        cleanRecord({
          id: a.id,
          accountType: a.accountType,
          financialInstitution: str(a.financialInstitution),
          // Full account number is write-only; send only when newly entered
          // (>= 4 chars per wire schema); the server echoes last4.
          accountNumber: a.accountNumber && a.accountNumber.trim().length >= 4 ? a.accountNumber.trim() : undefined,
          accountNumberLast4: a.accountNumberLast4 && /^\d{4}$/.test(a.accountNumberLast4) ? a.accountNumberLast4 : undefined,
          cashOrMarketValue: nonNeg(a.cashOrMarketValue),
          source: str(a.source),
        }),
      ),
    otherCredits: (d.otherCredits ?? [])
      .filter((c) => str(c.type))
      .map((c) => cleanRecord({ id: c.id, type: c.type, sourceOrDonor: str(c.sourceOrDonor), value: nonNeg(c.value) })),
    realEstateOwned: (d.realEstateOwned ?? []).map((r) =>
      cleanRecord({
        id: r.id,
        address: cleanAddress(r.address) ?? { ...EMPTY_ADDRESS },
        propertyValue: nonNeg(r.propertyValue),
        status: str(r.status),
        intendedOccupancy: str(r.intendedOccupancy),
        monthlyInsuranceTaxesHoa: nonNeg(r.monthlyInsuranceTaxesHoa),
        monthlyRentalIncome: nonNeg(r.monthlyRentalIncome),
        netMonthlyRentalIncome: nonNeg(r.netMonthlyRentalIncome),
        mortgages: (r.mortgages ?? [])
          .filter((m) => str(m.creditor))
          .map((m) =>
            cleanRecord({
              creditor: m.creditor,
              accountNumber: m.accountNumber && m.accountNumber.trim().length >= 4 ? m.accountNumber.trim() : undefined,
              accountNumberLast4: m.accountNumberLast4 && /^\d{4}$/.test(m.accountNumberLast4) ? m.accountNumberLast4 : undefined,
              monthlyPayment: nonNeg(m.monthlyPayment),
              unpaidBalance: nonNeg(m.unpaidBalance),
              paidOffAtClosing: m.paidOffAtClosing,
              mortgageType: str(m.mortgageType),
            }),
          ),
      }),
    ),
  });
}

export function buildLiabilitiesPayload(d: LiabilitiesSection): Record<string, unknown> {
  return cleanRecord({
    liabilities: (d.liabilities ?? [])
      .filter((l) => str(l.accountType))
      .map((l) =>
        cleanRecord({
          id: l.id,
          accountType: l.accountType,
          companyName: str(l.companyName),
          accountNumber: l.accountNumber && l.accountNumber.trim().length >= 4 ? l.accountNumber.trim() : undefined,
          accountNumberLast4: l.accountNumberLast4 && /^\d{4}$/.test(l.accountNumberLast4) ? l.accountNumberLast4 : undefined,
          unpaidBalance: nonNeg(l.unpaidBalance),
          monthlyPayment: nonNeg(l.monthlyPayment),
          monthsLeft: num(l.monthsLeft),
          paidOffAtClosing: l.paidOffAtClosing,
        }),
      ),
    otherLiabilities: (d.otherLiabilities ?? [])
      .filter((o) => str(o.type) && nonNeg(o.monthlyPayment) !== undefined)
      .map((o) => cleanRecord({ id: o.id, type: o.type, monthlyPayment: o.monthlyPayment })),
  });
}

export function buildSubjectPropertyPayload(d: SubjectProperty): Record<string, unknown> {
  return cleanRecord({
    address: cleanAddress(d.address),
    // geocode is server-set on save (REQ-040) — never echoed from the client.
    numberOfUnits: num(d.numberOfUnits),
    propertyType: str(d.propertyType),
    occupancy: str(d.occupancy),
    mixedUse: typeof d.mixedUse === "boolean" ? d.mixedUse : undefined,
    manufacturedHome: typeof d.manufacturedHome === "boolean" ? d.manufacturedHome : undefined,
    // VR-135: collected only when manufacturedHome is true; ignored otherwise.
    manufacturedHomeLandInterest:
      d.manufacturedHome === true ? str(d.manufacturedHomeLandInterest) : undefined,
    estimatedValue: nonNeg(d.estimatedValue),
    expectedMonthlyRentalIncome: nonNeg(d.expectedMonthlyRentalIncome),
    titleNames: str(d.titleNames),
    titleManner: str(d.titleManner),
    estate: str(d.estate),
    leaseholdExpirationDate: d.estate === "leasehold" ? isoDate(d.leaseholdExpirationDate) : undefined,
    targetClosingDate: isoDate(d.targetClosingDate),
  });
}

export function buildLoanDetailsPayload(d: LoanDetailsSection): Record<string, unknown> {
  const term = num(d.loanTermMonths);
  const phe = d.proposedHousingExpense;
  const refi = d.refinance;
  const pheClean = phe
    ? cleanRecord({
        firstMortgagePi: nonNeg(phe.firstMortgagePi),
        subordinateLiens: nonNeg(phe.subordinateLiens),
        homeownersInsurance: nonNeg(phe.homeownersInsurance),
        supplementalInsurance: nonNeg(phe.supplementalInsurance),
        propertyTaxes: nonNeg(phe.propertyTaxes),
        mortgageInsurance: nonNeg(phe.mortgageInsurance),
        hoaDues: nonNeg(phe.hoaDues),
        other: nonNeg(phe.other),
      })
    : undefined;
  const refiClean = refi
    ? cleanRecord({
        originalCost: nonNeg(refi.originalCost),
        existingLiens: nonNeg(refi.existingLiens),
        purposeOfRefinance: str(refi.purposeOfRefinance),
        improvementsDescription: str(refi.improvementsDescription),
        improvementsCost: nonNeg(refi.improvementsCost),
      })
    : undefined;
  return cleanRecord({
    loanPurpose: str(d.loanPurpose),
    loanType: str(d.loanType),
    amortizationType: str(d.amortizationType),
    armInitialFixedMonths: d.amortizationType === "adjustable" ? num(d.armInitialFixedMonths) : undefined,
    armAdjustmentMonths: d.amortizationType === "adjustable" ? num(d.armAdjustmentMonths) : undefined,
    loanTermMonths: term !== undefined && [120, 180, 240, 360].includes(term) ? term : undefined,
    requestedLoanAmount: nonNeg(d.requestedLoanAmount),
    downPaymentAmount: nonNeg(d.downPaymentAmount),
    downPaymentSource: str(d.downPaymentSource),
    otherNewMortgages: (d.otherNewMortgages ?? [])
      .filter((m) => str(m.creditor))
      .map((m) =>
        cleanRecord({
          creditor: m.creditor,
          lienType: str(m.lienType),
          monthlyPayment: nonNeg(m.monthlyPayment),
          amount: nonNeg(m.amount),
          creditLimit: nonNeg(m.creditLimit),
        }),
      ),
    refinance: refiClean && Object.keys(refiClean).length > 0 ? refiClean : undefined,
    proposedHousingExpense: pheClean && Object.keys(pheClean).length > 0 ? pheClean : undefined,
  });
}

export function buildDeclarationsPayload(d: Declarations): Record<string, unknown> {
  return cleanRecord({
    aOccupyPrimary: d.aOccupyPrimary,
    a1PriorOwnership: d.a1PriorOwnership,
    a1PropertyType: d.a1PriorOwnership === true ? str(d.a1PropertyType) : undefined,
    a1TitleHeld: d.a1PriorOwnership === true ? str(d.a1TitleHeld) : undefined,
    bSellerRelationship: d.bSellerRelationship,
    cUndisclosedBorrowing: d.cUndisclosedBorrowing,
    cAmount: d.cUndisclosedBorrowing === true ? nonNeg(d.cAmount) : undefined,
    d1OtherMortgageApplication: d.d1OtherMortgageApplication,
    d2NewCreditApplication: d.d2NewCreditApplication,
    ePriorityLien: d.ePriorityLien,
    fCosignerUndisclosed: d.fCosignerUndisclosed,
    gOutstandingJudgments: d.gOutstandingJudgments,
    hFederalDebtDelinquent: d.hFederalDebtDelinquent,
    iPartyToLawsuit: d.iPartyToLawsuit,
    jConveyedTitleInLieu: d.jConveyedTitleInLieu,
    kPreForeclosureSale: d.kPreForeclosureSale,
    lForeclosed: d.lForeclosed,
    mBankruptcy: d.mBankruptcy,
    mBankruptcyType: d.mBankruptcy === true ? str(d.mBankruptcyType) : undefined,
  });
}

export function buildDemographicsPayload(d: Demographics): Record<string, unknown> {
  return cleanRecord({
    ethnicity: d.ethnicity && d.ethnicity.length > 0 ? d.ethnicity : undefined,
    ethnicityOtherDetail: str(d.ethnicityOtherDetail),
    race: d.race && d.race.length > 0 ? d.race : undefined,
    raceOtherDetails:
      d.raceOtherDetails && d.raceOtherDetails.filter((r) => r.trim() !== "").length > 0
        ? d.raceOtherDetails.filter((r) => r.trim() !== "")
        : undefined,
    sex: str(d.sex),
    // §4.2.4 Step 9: collection method system-set to Email/Internet; visual
    // observation recorded as No (DATA-003).
    collectionMethod: "email-or-internet",
    visualObservation: false,
  });
}

// ---------------------------------------------------------------------------
// Section key helpers ("<section>:<ordinal|0>")
// ---------------------------------------------------------------------------

export type SectionKey = string;

export function sectionKey(section: string, ordinal?: number): SectionKey {
  return `${section}:${ordinal ?? 0}`;
}

export function parseSectionKey(key: SectionKey): { section: string; ordinal?: number } {
  const [section, o] = key.split(":");
  const ordinal = Number(o);
  return { section, ordinal: ordinal > 0 ? ordinal : undefined };
}

/**
 * Build the full SectionSaveRequest body for a dirty section key from the
 * current draft (VR-056..VR-067: exactly one payload field matching `section`;
 * borrowerOrdinal on per-borrower sections).
 */
export function buildSaveBody(
  draft: WizardDraft,
  key: SectionKey,
  versionStamp: number,
  confirmCopiedSection?: boolean,
): { section: string; body: Record<string, unknown> } | null {
  const { section, ordinal } = parseSectionKey(key);
  const base: Record<string, unknown> = { versionStamp, section };
  if (ordinal !== undefined) base.borrowerOrdinal = ordinal;
  if (confirmCopiedSection) base.confirmCopiedSection = true;
  const b = ordinal !== undefined ? draft.borrowers[ordinal] : undefined;
  switch (section) {
    case "identity":
      if (!b) return null;
      base.identity = buildIdentityPayload(b.identity);
      break;
    case "address-history":
      if (!b) return null;
      base.addressHistory = buildAddressHistoryPayload(b.addressHistory);
      break;
    case "employment-income":
      if (!b) return null;
      base.employmentIncome = buildEmploymentPayload(b.employmentIncome);
      break;
    case "declarations":
      if (!b) return null;
      base.declarations = buildDeclarationsPayload(b.declarations);
      break;
    case "demographics":
      if (!b) return null;
      base.demographics = buildDemographicsPayload(b.demographics);
      break;
    case "assets-reo":
      base.assetsReo = buildAssetsPayload(draft.assetsReo);
      break;
    case "liabilities":
      base.liabilities = buildLiabilitiesPayload(draft.liabilities);
      break;
    case "subject-property":
      base.subjectProperty = buildSubjectPropertyPayload(draft.subjectProperty);
      break;
    case "loan-details":
      base.loanDetails = buildLoanDetailsPayload(draft.loanDetails);
      break;
    default:
      return null;
  }
  return { section, body: base };
}
