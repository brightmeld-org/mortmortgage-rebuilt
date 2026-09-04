// Application / wizard request schemas (task-011) — STRICT zod mirrors of
// contracts.json shapes. Field names and enum literals are VERBATIM from
// contracts.json (the machine-readable authority); unknown fields are rejected
// (SEC-18) via strictSchema.
//
// Draft partiality (§A note): storage shapes are mostly optional — per-field
// constraints (types, enums, formats, ranges VR-069/070/071/072, VR-126..129,
// monetary sign INV-025) are enforced HERE on write; MISSING required fields
// are NOT save errors — they surface through the pure validation engine
// (src/lib/pure/urla-validation.ts). Within a nested shape, contract-required
// fields (e.g. Address.street) must be PRESENT but may be empty strings while
// drafting; submission requiredness is the engine's job.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

// ---------------------------------------------------------------------------
// Enum literals — verbatim from contracts.json `enums`
// ---------------------------------------------------------------------------

export const WIZARD_SECTIONS = [
  "identity",
  "address-history",
  "employment-income",
  "assets-reo",
  "liabilities",
  "subject-property",
  "loan-details",
  "declarations",
  "demographics",
] as const;
export type WizardSectionValue = (typeof WIZARD_SECTIONS)[number];

const citizenshipEnum = z.enum(["us-citizen", "permanent-resident-alien", "non-permanent-resident-alien"]);
const maritalStatusEnum = z.enum(["married", "separated", "unmarried"]);
const creditTypeEnum = z.enum(["individual", "joint"]);
const housingStatusEnum = z.enum(["own", "rent", "no-primary-housing-expense"]);
const employmentTypeEnum = z.enum(["employed", "self-employed", "retired", "not-employed"]);
const militaryServiceStatusEnum = z.enum([
  "currently-serving",
  "retired-discharged",
  "reserve-national-guard-non-activated",
  "surviving-spouse",
]);
const otherIncomeSourceEnum = z.enum([
  "alimony",
  "child-support",
  "separate-maintenance",
  "rental",
  "retirement",
  "social-security",
  "disability",
  "interest-dividends",
  "public-assistance",
  "trust",
  "unemployment",
  "va-compensation",
  "other",
]);
const assetAccountTypeEnum = z.enum([
  "checking",
  "savings",
  "money-market",
  "cd",
  "mutual-fund",
  "stocks",
  "bonds",
  "retirement",
  "stock-options",
  "bridge-loan-proceeds",
  "trust",
  "cash-value-life-insurance",
  "other",
]);
const assetSourceEnum = z.enum(["manual", "bank-link"]);
const otherCreditTypeEnum = z.enum([
  "proceeds-real-estate-sale",
  "proceeds-non-real-estate-sale",
  "secured-borrowed-funds",
  "unsecured-borrowed-funds",
  "gift-of-cash",
  "gift-of-equity",
  "grant",
  "earnest-money",
  "employer-assistance",
  "lot-equity",
  "relocation-funds",
  "rent-credit",
  "sweat-equity",
  "trade-equity",
  "other",
]);
const reoStatusEnum = z.enum(["sold", "pending-sale", "retained"]);
const liabilityAccountTypeEnum = z.enum(["revolving", "installment", "open-30-day", "lease", "other"]);
const otherLiabilityTypeEnum = z.enum([
  "alimony",
  "child-support",
  "separate-maintenance",
  "job-related-expenses",
  "other",
]);
const propertyTypeEnum = z.enum([
  "single-family-detached",
  "townhouse-pud",
  "condominium",
  "cooperative",
  "two-unit",
  "three-unit",
  "four-unit",
  "manufactured-home",
]);
const occupancyTypeEnum = z.enum(["primary-residence", "second-home", "investment-property"]);
/** contracts.json enums.ManufacturedHomeLandInterest, verbatim (VR-135). */
export const MANUFACTURED_HOME_LAND_INTERESTS = [
  "direct-ownership",
  "indirect-ownership",
  "paid-leasehold",
  "unpaid-leasehold",
  "not-applicable",
] as const;
const manufacturedHomeLandInterestEnum = z.enum(MANUFACTURED_HOME_LAND_INTERESTS);
const titleMannerEnum = z.enum([
  "sole-ownership",
  "joint-tenancy-right-of-survivorship",
  "tenancy-in-common",
  "tenancy-by-entirety",
  "life-estate",
  "trust",
  "other",
]);
const titleHeldTypeEnum = z.enum(["by-yourself", "jointly-with-spouse", "jointly-with-another"]);
const estateTypeEnum = z.enum(["fee-simple", "leasehold"]);
const loanPurposeEnum = z.enum([
  "purchase",
  "refinance-rate-term",
  "refinance-cash-out",
  "construction",
  "construction-to-permanent",
]);
const loanTypeEnum = z.enum(["conventional", "fha", "va", "usda"]);
const amortizationTypeEnum = z.enum(["fixed", "adjustable"]);
const lienTypeEnum = z.enum(["first-lien", "subordinate-lien"]);
const refinancePurposeEnum = z.enum(["no-cash-out", "limited-cash-out", "cash-out"]);
const bankruptcyTypeEnum = z.enum(["chapter-7", "chapter-11", "chapter-12", "chapter-13"]);
const ethnicityValueEnum = z.enum([
  "hispanic-or-latino",
  "mexican",
  "puerto-rican",
  "cuban",
  "other-hispanic-or-latino",
  "not-hispanic-or-latino",
  "not-provided",
]);
const raceValueEnum = z.enum([
  "american-indian-or-alaska-native",
  "asian",
  "asian-indian",
  "chinese",
  "filipino",
  "japanese",
  "korean",
  "vietnamese",
  "other-asian",
  "black-or-african-american",
  "native-hawaiian-or-pacific-islander",
  "native-hawaiian",
  "guamanian-or-chamorro",
  "samoan",
  "other-pacific-islander",
  "white",
  "not-provided",
]);
const sexValueEnum = z.enum(["female", "male", "not-provided"]);
export const wizardSectionEnum = z.enum(WIZARD_SECTIONS);

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

/** Currency (dollars with cents) — negative rejected (INV-025). */
const currency = z.number().finite().nonnegative();
/** The ONE currency field where a negative value (loss) is permitted (INV-025). */
const currencyAllowLoss = z.number().finite();
/** ISO 8601 calendar date, YYYY-MM-DD (VR-070 and every plain-date field). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO 8601 date (YYYY-MM-DD)");
/** Full SSN write format ###-##-#### (VR-069). */
const ssnFormat = z.string().regex(/^\d{3}-\d{2}-\d{4}$/, "must be formatted ###-##-####");
/** Row ids are server-generated UUIDs; clients may echo them on round-trip. */
const rowId = z.string().uuid();

// ---------------------------------------------------------------------------
// Nested shapes (contracts.json models, verbatim field names)
// ---------------------------------------------------------------------------

export const addressSchema = strictSchema({
  street: z.string().max(500),
  unit: z.string().max(100).optional(),
  city: z.string().max(200),
  state: z.string().max(100),
  zip: z.string().max(20),
  county: z.string().max(200).optional(),
  country: z.string().max(100).optional(),
});

export const geoPointSchema = strictSchema({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  county: z.string().max(200).optional(),
  censusTract: z.string().max(50).optional(),
});

export const militaryServiceSchema = strictSchema({
  served: z.boolean(),
  status: militaryServiceStatusEnum.optional(),
  projectedExpirationDate: isoDate.optional(),
});

export const previousAddressSchema = strictSchema({
  address: addressSchema,
  housingStatus: housingStatusEnum.optional(),
  yearsAtAddress: z.number().int().min(0).max(120).optional(),
  monthsAtAddress: z.number().int().min(0).max(11).optional(),
  // VR-132 (CH-016): the interval endpoints the gap-free 24-month address
  // union is computed from. OPTIONAL on the wire so DRAFTS keep saving — there
  // is NO duration-sum fallback: at the submission gate a row missing either
  // endpoint is undatable, contributes no coverage, and fails validation with
  // a field error naming the missing date (src/lib/pure/urla-validation.ts).
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});

export const employmentRecordSchema = strictSchema({
  id: rowId.optional(),
  employerName: z.string().max(300),
  employerAddress: addressSchema.optional(),
  employerPhone: z.string().max(50).optional(),
  position: z.string().max(200).optional(),
  startDate: isoDate.optional(),
  yearsInLineOfWork: z.number().finite().min(0).max(100).optional(),
  selfEmployed: z.boolean(),
  ownershipShareGte25: z.boolean().optional(),
  employedByFamilyOrParty: z.boolean().optional(),
  baseMonthlyIncome: currency.optional(),
  overtime: currency.optional(),
  bonus: currency.optional(),
  commission: currency.optional(),
  militaryEntitlements: currency.optional(),
  otherMonthlyIncome: currency.optional(),
  selfEmployedMonthlyIncome: currencyAllowLoss.optional(),
});

export const previousEmploymentRecordSchema = strictSchema({
  id: rowId.optional(),
  employerName: z.string().max(300),
  employerAddress: addressSchema.optional(),
  position: z.string().max(200).optional(),
  startDate: isoDate,
  endDate: isoDate,
  previousGrossMonthlyIncome: currency.optional(),
});

export const otherIncomeRecordSchema = strictSchema({
  id: rowId.optional(),
  source: otherIncomeSourceEnum,
  monthlyAmount: currency,
});

export const declarationsSchema = strictSchema({
  aOccupyPrimary: z.boolean().optional(),
  a1PriorOwnership: z.boolean().optional(),
  a1PropertyType: occupancyTypeEnum.optional(),
  a1TitleHeld: titleHeldTypeEnum.optional(),
  bSellerRelationship: z.boolean().optional(),
  cUndisclosedBorrowing: z.boolean().optional(),
  cAmount: currency.optional(),
  d1OtherMortgageApplication: z.boolean().optional(),
  d2NewCreditApplication: z.boolean().optional(),
  ePriorityLien: z.boolean().optional(),
  fCosignerUndisclosed: z.boolean().optional(),
  gOutstandingJudgments: z.boolean().optional(),
  hFederalDebtDelinquent: z.boolean().optional(),
  iPartyToLawsuit: z.boolean().optional(),
  jConveyedTitleInLieu: z.boolean().optional(),
  kPreForeclosureSale: z.boolean().optional(),
  lForeclosed: z.boolean().optional(),
  mBankruptcy: z.boolean().optional(),
  mBankruptcyType: bankruptcyTypeEnum.optional(),
});

export const demographicsSchema = strictSchema({
  ethnicity: z.array(ethnicityValueEnum).max(10).optional(),
  ethnicityOtherDetail: z.string().max(300).optional(),
  race: z.array(raceValueEnum).max(20).optional(),
  raceOtherDetails: z.array(z.string().max(300)).max(20).optional(),
  sex: sexValueEnum.optional(),
  collectionMethod: z.string().max(100).optional(),
  visualObservation: z.boolean().optional(),
});

export const assetRecordSchema = strictSchema({
  id: rowId.optional(),
  accountType: assetAccountTypeEnum,
  financialInstitution: z.string().max(300).optional(),
  // Write-only full account number; encrypted at rest; responses carry last4 only.
  accountNumber: z.string().min(4).max(50).optional(),
  accountNumberLast4: z.string().regex(/^\d{4}$/).optional(),
  cashOrMarketValue: currency.optional(),
  source: assetSourceEnum.optional(),
});

export const otherCreditRecordSchema = strictSchema({
  id: rowId.optional(),
  type: otherCreditTypeEnum,
  sourceOrDonor: z.string().max(300).optional(),
  value: currency.optional(),
});

export const reoMortgageSchema = strictSchema({
  creditor: z.string().max(300),
  accountNumber: z.string().min(4).max(50).optional(),
  accountNumberLast4: z.string().regex(/^\d{4}$/).optional(),
  monthlyPayment: currency.optional(),
  unpaidBalance: currency.optional(),
  paidOffAtClosing: z.boolean().optional(),
  mortgageType: loanTypeEnum.optional(),
});

export const realEstateOwnedRecordSchema = strictSchema({
  id: rowId.optional(),
  address: addressSchema,
  propertyValue: currency.optional(),
  status: reoStatusEnum.optional(),
  intendedOccupancy: occupancyTypeEnum.optional(),
  monthlyInsuranceTaxesHoa: currency.optional(),
  monthlyRentalIncome: currency.optional(),
  netMonthlyRentalIncome: currency.optional(),
  mortgages: z.array(reoMortgageSchema).max(20).optional(),
});

export const liabilityRecordSchema = strictSchema({
  id: rowId.optional(),
  accountType: liabilityAccountTypeEnum,
  companyName: z.string().max(300).optional(),
  accountNumber: z.string().min(4).max(50).optional(),
  accountNumberLast4: z.string().regex(/^\d{4}$/).optional(),
  unpaidBalance: currency.optional(),
  monthlyPayment: currency.optional(),
  monthsLeft: z.number().int().min(0).max(1200).optional(),
  paidOffAtClosing: z.boolean().optional(),
});

export const otherLiabilityRecordSchema = strictSchema({
  id: rowId.optional(),
  type: otherLiabilityTypeEnum,
  monthlyPayment: currency,
});

export const subjectPropertySchema = strictSchema({
  address: addressSchema.optional(),
  geocode: geoPointSchema.optional(),
  // VR-128: numberOfUnits range 1..4.
  numberOfUnits: z.number().int().min(1).max(4).optional(),
  propertyType: propertyTypeEnum.optional(),
  occupancy: occupancyTypeEnum.optional(),
  mixedUse: z.boolean().optional(),
  manufacturedHome: z.boolean().optional(),
  // VR-135: collected when manufacturedHome is true; ignored otherwise. Sole
  // source for HMDA LAR fields 89/90. OPTIONAL so pre-existing applications
  // stay valid.
  manufacturedHomeLandInterest: manufacturedHomeLandInterestEnum.optional(),
  estimatedValue: currency.optional(),
  expectedMonthlyRentalIncome: currency.optional(),
  titleNames: z.string().max(500).optional(),
  titleManner: titleMannerEnum.optional(),
  estate: estateTypeEnum.optional(),
  leaseholdExpirationDate: isoDate.optional(),
  targetClosingDate: isoDate.optional(),
});

export const otherNewMortgageSchema = strictSchema({
  creditor: z.string().max(300),
  lienType: lienTypeEnum.optional(),
  monthlyPayment: currency.optional(),
  amount: currency.optional(),
  creditLimit: currency.optional(),
});

export const refinanceDetailsSchema = strictSchema({
  originalCost: currency.optional(),
  existingLiens: currency.optional(),
  purposeOfRefinance: refinancePurposeEnum.optional(),
  improvementsDescription: z.string().max(2000).optional(),
  improvementsCost: currency.optional(),
});

/**
 * contracts.json models.ProposedHousingExpense — all 8 fields optional
 * non-negative currency (INV-025), verbatim contract names. THE canonical
 * shape: consumed by the loan-details section payload (wire) and by the
 * corrections service's `proposedHousingExpense` shared root (storage).
 */
export const proposedHousingExpenseSchema = strictSchema({
  firstMortgagePi: currency.optional(),
  subordinateLiens: currency.optional(),
  homeownersInsurance: currency.optional(),
  supplementalInsurance: currency.optional(),
  propertyTaxes: currency.optional(),
  mortgageInsurance: currency.optional(),
  hoaDues: currency.optional(),
  other: currency.optional(),
});

/**
 * contracts.md §A LoanDetails as it is STORED (the ApplicationData.loan JSON
 * column). The contracted `proposedHousingExpense` group is deliberately NOT
 * part of this shape: §A ApplicationData keeps that group in its own top-level
 * `proposedHousingExpense` field, which is the single place the DTI numerator
 * (§E) reads it from and the single path corrections address. The wire shape
 * that nests it — SectionSaveRequest.loanDetails — is `loanDetailsSectionSchema`.
 */
export const loanDetailsSchema = strictSchema({
  loanPurpose: loanPurposeEnum.optional(),
  loanType: loanTypeEnum.optional(),
  amortizationType: amortizationTypeEnum.optional(),
  armInitialFixedMonths: z.number().int().min(0).max(600).optional(),
  armAdjustmentMonths: z.number().int().min(0).max(600).optional(),
  // VR-126 / INV-025: one of 120, 180, 240, 360.
  loanTermMonths: z.union(
    [z.literal(120), z.literal(180), z.literal(240), z.literal(360)],
    { errorMap: () => ({ message: "loanTermMonths must be one of 120, 180, 240, 360" }) },
  ).optional(),
  // VR-127: 0..999999999, negative rejected, no upper business cap below that.
  requestedLoanAmount: z.number().finite().min(0).max(999999999).optional(),
  downPaymentAmount: currency.optional(),
  downPaymentSource: z.string().max(200).optional(),
  otherNewMortgages: z.array(otherNewMortgageSchema).max(20).optional(),
  refinance: refinanceDetailsSchema.optional(),
});

// ---------------------------------------------------------------------------
// Section payloads (SectionSaveRequest sub-shapes)
// ---------------------------------------------------------------------------

export const borrowerIdentitySectionSchema = strictSchema({
  firstName: z.string().max(200).optional(),
  middleName: z.string().max(200).optional(),
  lastName: z.string().max(200).optional(),
  suffix: z.string().max(50).optional(),
  alternateNames: z.array(z.string().max(300)).max(20).optional(),
  // VR-069: ###-##-#### — full SSN appears here (write) and on identity-own only.
  ssn: ssnFormat.optional(),
  // VR-070: ISO 8601 date.
  dateOfBirth: isoDate.optional(),
  // VR-072: enum-value.
  citizenship: citizenshipEnum.optional(),
  maritalStatus: maritalStatusEnum.optional(),
  // VR-129: range 0..20.
  dependentsCount: z.number().int().min(0).max(20).optional(),
  dependentsAges: z.string().max(200).optional(),
  homePhone: z.string().max(50).optional(),
  cellPhone: z.string().max(50).optional(),
  workPhone: z.string().max(50).optional(),
  workPhoneExt: z.string().max(20).optional(),
  // VR-071: email format.
  email: z.string().email().max(320).optional(),
  creditType: creditTypeEnum.optional(),
  militaryService: militaryServiceSchema.optional(),
});

export const addressHistorySectionSchema = strictSchema({
  currentAddress: addressSchema.optional(),
  housingStatus: housingStatusEnum.optional(),
  monthlyRent: currency.optional(),
  yearsAtAddress: z.number().int().min(0).max(120).optional(),
  monthsAtAddress: z.number().int().min(0).max(11).optional(),
  previousAddresses: z.array(previousAddressSchema).max(20).optional(),
  mailingAddressDifferent: z.boolean().optional(),
  mailingAddress: addressSchema.optional(),
});

export const employmentSectionSchema = strictSchema({
  employmentType: employmentTypeEnum.optional(),
  employments: z.array(employmentRecordSchema).max(20).optional(),
  previousEmployments: z.array(previousEmploymentRecordSchema).max(20).optional(),
  otherIncome: z.array(otherIncomeRecordSchema).max(20).optional(),
});

export const assetsSectionSchema = strictSchema({
  assets: z.array(assetRecordSchema).max(50).optional(),
  otherCredits: z.array(otherCreditRecordSchema).max(50).optional(),
  realEstateOwned: z.array(realEstateOwnedRecordSchema).max(50).optional(),
});

export const liabilitiesSectionSchema = strictSchema({
  liabilities: z.array(liabilityRecordSchema).max(50).optional(),
  otherLiabilities: z.array(otherLiabilityRecordSchema).max(50).optional(),
});

/**
 * contracts.md §A LoanDetails as it arrives on the wire — the Step-7
 * SectionSaveRequest.loanDetails payload, which carries the
 * `proposedHousingExpense` group [REQ-030]. The group is optional at save time
 * (auto-save persists partial data); §4.2.4 Step-7 requiredness is enforced at
 * submission by the validation engine + T1/T36 gate, not here.
 */
export const loanDetailsSectionSchema = strictSchema({
  ...loanDetailsSchema.shape,
  proposedHousingExpense: proposedHousingExpenseSchema.optional(),
});

// ---------------------------------------------------------------------------
// Top-level requests
// ---------------------------------------------------------------------------

/** contracts.md §A CreateApplicationRequest (VR-052..VR-055). */
export const createApplicationRequestSchema = strictSchema({
  // VR-052: non-empty idempotency token (SEC-21).
  requestToken: z.string().min(1).max(200),
  // VR-053: uuid format.
  copyFromApplicationId: z.string().uuid().optional(),
  // VR-054: WizardSection values; requires copyFromApplicationId (cross-field below).
  copySections: z.array(wizardSectionEnum).max(WIZARD_SECTIONS.length).optional(),
  // VR-055: <= 4096; expired/tampered tokens are IGNORED (plain Draft), never an error.
  handoffToken: z.string().max(4096).optional(),
}).superRefine((body, ctx) => {
  if (body.copySections !== undefined && body.copySections.length > 0 && !body.copyFromApplicationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["copySections"],
      message: "copySections requires copyFromApplicationId",
    });
  }
});

/** SectionSaveRequest payload-field name per WizardSection value (VR-059..VR-067). */
export const SECTION_PAYLOAD_FIELDS = {
  identity: "identity",
  "address-history": "addressHistory",
  "employment-income": "employmentIncome",
  "assets-reo": "assetsReo",
  liabilities: "liabilities",
  "subject-property": "subjectProperty",
  "loan-details": "loanDetails",
  declarations: "declarations",
  demographics: "demographics",
} as const satisfies Record<WizardSectionValue, string>;

export type SectionPayloadField = (typeof SECTION_PAYLOAD_FIELDS)[WizardSectionValue];

const ALL_PAYLOAD_FIELDS = Object.values(SECTION_PAYLOAD_FIELDS) as SectionPayloadField[];

/** contracts.md §A SectionSaveRequest (VR-056..VR-068). */
export const sectionSaveRequestSchema = strictSchema({
  // VR-056: range 0..2147483647; staleness handled by the optimistic-lock check.
  versionStamp: z.number().int().min(0).max(2147483647),
  // VR-057: enum-value.
  section: wizardSectionEnum,
  // VR-058: 1..2; requiredness for per-borrower sections enforced in superRefine.
  borrowerOrdinal: z.number().int().min(1).max(2).optional(),
  identity: borrowerIdentitySectionSchema.optional(),
  addressHistory: addressHistorySectionSchema.optional(),
  employmentIncome: employmentSectionSchema.optional(),
  assetsReo: assetsSectionSchema.optional(),
  liabilities: liabilitiesSectionSchema.optional(),
  subjectProperty: subjectPropertySchema.optional(),
  loanDetails: loanDetailsSectionSchema.optional(),
  declarations: declarationsSchema.optional(),
  demographics: demographicsSchema.optional(),
  // VR-068: clears a staleness advisory without an edit.
  confirmCopiedSection: z.boolean().optional(),
}).superRefine((body, ctx) => {
  // VR-059..VR-067: exactly one section payload field, and it must match `section`.
  const presentFields = ALL_PAYLOAD_FIELDS.filter(
    (f) => (body as Record<string, unknown>)[f] !== undefined,
  );
  const expected = SECTION_PAYLOAD_FIELDS[body.section];
  if (presentFields.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [presentFields.length === 0 ? expected : presentFields[1]!],
      message: `exactly one section payload field must be present (expected "${expected}")`,
    });
  } else if (presentFields[0] !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [presentFields[0]!],
      message: `section payload field "${presentFields[0]}" does not match section "${body.section}" (expected "${expected}")`,
    });
  }
  // VR-058: borrowerOrdinal required for per-borrower sections.
  const perBorrower = ["identity", "address-history", "employment-income", "declarations", "demographics"];
  if (perBorrower.includes(body.section) && body.borrowerOrdinal === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["borrowerOrdinal"],
      message: `borrowerOrdinal (1..2) is required for the per-borrower section "${body.section}"`,
    });
  }
});

export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>;
export type SectionSaveRequest = z.infer<typeof sectionSaveRequestSchema>;
export type BorrowerIdentitySectionInput = z.infer<typeof borrowerIdentitySectionSchema>;
export type AddressHistorySectionInput = z.infer<typeof addressHistorySectionSchema>;
export type EmploymentSectionInput = z.infer<typeof employmentSectionSchema>;
export type AssetsSectionInput = z.infer<typeof assetsSectionSchema>;
export type LiabilitiesSectionInput = z.infer<typeof liabilitiesSectionSchema>;
export type SubjectPropertyInput = z.infer<typeof subjectPropertySchema>;
export type LoanDetailsInput = z.infer<typeof loanDetailsSchema>;
export type LoanDetailsSectionInput = z.infer<typeof loanDetailsSectionSchema>;
export type ProposedHousingExpenseInput = z.infer<typeof proposedHousingExpenseSchema>;
export type DeclarationsInput = z.infer<typeof declarationsSchema>;
export type DemographicsInput = z.infer<typeof demographicsSchema>;
