// UrlaWizard (task-016) — client mirrors of contracts.md §A shapes and enum
// option lists. EVERY enum literal below is copied VERBATIM from contracts.json
// `enums` (the machine-readable authority); display labels come from the RFP
// §4.2.4 field tables. Do not rename fields; do not invent values.

// ---------------------------------------------------------------------------
// Enum literal unions (contracts.json enums, verbatim)
// ---------------------------------------------------------------------------

export type WorkflowState =
  | "draft"
  | "application_received"
  | "completeness_validated"
  | "documents_received"
  | "aus_executed"
  | "preliminary_decision"
  | "escalated_review"
  | "conditional_approval"
  | "approved"
  | "denied"
  | "borrower_notified"
  | "revision_requested"
  | "suspended"
  | "withdrawn"
  | "declined_by_borrower";

export type WizardSection =
  | "identity"
  | "address-history"
  | "employment-income"
  | "assets-reo"
  | "liabilities"
  | "subject-property"
  | "loan-details"
  | "declarations"
  | "demographics";

export type IssueSeverity = "error" | "warning";
export type StepCompletion = "complete" | "in-progress" | "not-started";
export type SignatureMode = "drawn" | "typed" | "demo";
export type DocumentStatus = "pending" | "accepted" | "insufficient" | "waived";
export type DocumentJobStatus = "queued" | "processing" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Option lists (value = contracts.json literal, label = §4.2.4 wording)
// ---------------------------------------------------------------------------

export interface EnumOption {
  value: string;
  label: string;
}

export const CITIZENSHIP_OPTIONS: EnumOption[] = [
  { value: "us-citizen", label: "U.S. Citizen" },
  { value: "permanent-resident-alien", label: "Permanent Resident Alien" },
  { value: "non-permanent-resident-alien", label: "Non-Permanent Resident Alien" },
];

export const MARITAL_STATUS_OPTIONS: EnumOption[] = [
  { value: "married", label: "Married" },
  { value: "separated", label: "Separated" },
  { value: "unmarried", label: "Unmarried" },
];

export const CREDIT_TYPE_OPTIONS: EnumOption[] = [
  { value: "individual", label: "Individual" },
  { value: "joint", label: "Joint" },
];

export const HOUSING_STATUS_OPTIONS: EnumOption[] = [
  { value: "own", label: "Own" },
  { value: "rent", label: "Rent" },
  { value: "no-primary-housing-expense", label: "No primary housing expense" },
];

export const EMPLOYMENT_TYPE_OPTIONS: EnumOption[] = [
  { value: "employed", label: "Employed" },
  { value: "self-employed", label: "Self-employed" },
  { value: "retired", label: "Retired" },
  { value: "not-employed", label: "Not employed" },
];

export const MILITARY_SERVICE_STATUS_OPTIONS: EnumOption[] = [
  { value: "currently-serving", label: "Currently serving" },
  { value: "retired-discharged", label: "Retired or discharged" },
  { value: "reserve-national-guard-non-activated", label: "Non-activated Reserve or National Guard" },
  { value: "surviving-spouse", label: "Surviving spouse" },
];

export const OTHER_INCOME_SOURCE_OPTIONS: EnumOption[] = [
  { value: "alimony", label: "Alimony" },
  { value: "child-support", label: "Child support" },
  { value: "separate-maintenance", label: "Separate maintenance" },
  { value: "rental", label: "Rental" },
  { value: "retirement", label: "Retirement" },
  { value: "social-security", label: "Social Security" },
  { value: "disability", label: "Disability" },
  { value: "interest-dividends", label: "Interest / dividends" },
  { value: "public-assistance", label: "Public assistance" },
  { value: "trust", label: "Trust" },
  { value: "unemployment", label: "Unemployment" },
  { value: "va-compensation", label: "VA compensation" },
  { value: "other", label: "Other" },
];

export const ASSET_ACCOUNT_TYPE_OPTIONS: EnumOption[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "money-market", label: "Money market" },
  { value: "cd", label: "CD" },
  { value: "mutual-fund", label: "Mutual fund" },
  { value: "stocks", label: "Stocks" },
  { value: "bonds", label: "Bonds" },
  { value: "retirement", label: "Retirement" },
  { value: "stock-options", label: "Stock options" },
  { value: "bridge-loan-proceeds", label: "Bridge loan proceeds" },
  { value: "trust", label: "Trust" },
  { value: "cash-value-life-insurance", label: "Cash value of life insurance" },
  { value: "other", label: "Other" },
];

export const OTHER_CREDIT_TYPE_OPTIONS: EnumOption[] = [
  { value: "proceeds-real-estate-sale", label: "Proceeds from real estate sale" },
  { value: "proceeds-non-real-estate-sale", label: "Proceeds from sale of non-real-estate asset" },
  { value: "secured-borrowed-funds", label: "Secured borrowed funds" },
  { value: "unsecured-borrowed-funds", label: "Unsecured borrowed funds" },
  { value: "gift-of-cash", label: "Gift of cash" },
  { value: "gift-of-equity", label: "Gift of equity" },
  { value: "grant", label: "Grant" },
  { value: "earnest-money", label: "Earnest money" },
  { value: "employer-assistance", label: "Employer assistance" },
  { value: "lot-equity", label: "Lot equity" },
  { value: "relocation-funds", label: "Relocation funds" },
  { value: "rent-credit", label: "Rent credit" },
  { value: "sweat-equity", label: "Sweat equity" },
  { value: "trade-equity", label: "Trade equity" },
  { value: "other", label: "Other" },
];

export const REO_STATUS_OPTIONS: EnumOption[] = [
  { value: "sold", label: "Sold" },
  { value: "pending-sale", label: "Pending sale" },
  { value: "retained", label: "Retained" },
];

export const LIABILITY_ACCOUNT_TYPE_OPTIONS: EnumOption[] = [
  { value: "revolving", label: "Revolving" },
  { value: "installment", label: "Installment" },
  { value: "open-30-day", label: "Open 30-day" },
  { value: "lease", label: "Lease" },
  { value: "other", label: "Other" },
];

export const OTHER_LIABILITY_TYPE_OPTIONS: EnumOption[] = [
  { value: "alimony", label: "Alimony" },
  { value: "child-support", label: "Child support" },
  { value: "separate-maintenance", label: "Separate maintenance" },
  { value: "job-related-expenses", label: "Job-related expenses" },
  { value: "other", label: "Other" },
];

export const PROPERTY_TYPE_OPTIONS: EnumOption[] = [
  { value: "single-family-detached", label: "Single-family detached" },
  { value: "townhouse-pud", label: "Townhouse / PUD" },
  { value: "condominium", label: "Condominium" },
  { value: "cooperative", label: "Cooperative" },
  { value: "two-unit", label: "2-unit" },
  { value: "three-unit", label: "3-unit" },
  { value: "four-unit", label: "4-unit" },
  { value: "manufactured-home", label: "Manufactured home" },
];

export const OCCUPANCY_TYPE_OPTIONS: EnumOption[] = [
  { value: "primary-residence", label: "Primary residence" },
  { value: "second-home", label: "Second home" },
  { value: "investment-property", label: "Investment property" },
];

/** contracts.json enums.ManufacturedHomeLandInterest (VR-135). */
export const MANUFACTURED_HOME_LAND_INTEREST_OPTIONS: EnumOption[] = [
  { value: "direct-ownership", label: "Direct ownership of the land" },
  { value: "indirect-ownership", label: "Indirect ownership of the land" },
  { value: "paid-leasehold", label: "Paid leasehold" },
  { value: "unpaid-leasehold", label: "Unpaid leasehold" },
  { value: "not-applicable", label: "Not applicable" },
];

export const TITLE_MANNER_OPTIONS: EnumOption[] = [
  { value: "sole-ownership", label: "Sole ownership" },
  { value: "joint-tenancy-right-of-survivorship", label: "Joint tenancy with right of survivorship" },
  { value: "tenancy-in-common", label: "Tenancy in common" },
  { value: "tenancy-by-entirety", label: "Tenancy by the entirety" },
  { value: "life-estate", label: "Life estate" },
  { value: "trust", label: "Trust" },
  { value: "other", label: "Other" },
];

export const TITLE_HELD_TYPE_OPTIONS: EnumOption[] = [
  { value: "by-yourself", label: "By yourself" },
  { value: "jointly-with-spouse", label: "Jointly with your spouse" },
  { value: "jointly-with-another", label: "Jointly with another person" },
];

export const ESTATE_TYPE_OPTIONS: EnumOption[] = [
  { value: "fee-simple", label: "Fee simple" },
  { value: "leasehold", label: "Leasehold" },
];

export const LOAN_PURPOSE_OPTIONS: EnumOption[] = [
  { value: "purchase", label: "Purchase" },
  { value: "refinance-rate-term", label: "Refinance — rate/term" },
  { value: "refinance-cash-out", label: "Refinance — cash-out" },
  { value: "construction", label: "Construction" },
  { value: "construction-to-permanent", label: "Construction-to-permanent" },
];

export const LOAN_TYPE_OPTIONS: EnumOption[] = [
  { value: "conventional", label: "Conventional" },
  { value: "fha", label: "FHA" },
  { value: "va", label: "VA" },
  { value: "usda", label: "USDA-RD" },
];

export const AMORTIZATION_TYPE_OPTIONS: EnumOption[] = [
  { value: "fixed", label: "Fixed" },
  { value: "adjustable", label: "Adjustable" },
];

export const LIEN_TYPE_OPTIONS: EnumOption[] = [
  { value: "first-lien", label: "First lien" },
  { value: "subordinate-lien", label: "Subordinate lien" },
];

export const REFINANCE_PURPOSE_OPTIONS: EnumOption[] = [
  { value: "no-cash-out", label: "No cash-out" },
  { value: "limited-cash-out", label: "Limited cash-out" },
  { value: "cash-out", label: "Cash-out" },
];

export const BANKRUPTCY_TYPE_OPTIONS: EnumOption[] = [
  { value: "chapter-7", label: "Chapter 7" },
  { value: "chapter-11", label: "Chapter 11" },
  { value: "chapter-12", label: "Chapter 12" },
  { value: "chapter-13", label: "Chapter 13" },
];

export const LOAN_TERM_OPTIONS: EnumOption[] = [
  { value: "120", label: "120 months (10 years)" },
  { value: "180", label: "180 months (15 years)" },
  { value: "240", label: "240 months (20 years)" },
  { value: "360", label: "360 months (30 years)" },
];

export const DOCUMENT_TYPE_OPTIONS: EnumOption[] = [
  { value: "w2", label: "W-2" },
  { value: "pay-stub", label: "Pay Stub" },
  { value: "bank-statement", label: "Bank Statement" },
  { value: "tax-return-1040", label: "Tax Return (1040)" },
  { value: "government-id", label: "Government-Issued ID" },
  { value: "gift-letter", label: "Gift Letter" },
  { value: "purchase-agreement", label: "Purchase Agreement" },
  { value: "homeowners-insurance-quote", label: "Homeowner's Insurance Quote" },
  { value: "other", label: "Other" },
];

// Step 9 ethnicity/race sub-option groupings (§4.2.4 Step 9 wording; values verbatim).
export const ETHNICITY_ROOT_OPTIONS: EnumOption[] = [
  { value: "hispanic-or-latino", label: "Hispanic or Latino" },
  { value: "not-hispanic-or-latino", label: "Not Hispanic or Latino" },
  { value: "not-provided", label: "I do not wish to provide this information" },
];
export const ETHNICITY_HISPANIC_SUBOPTIONS: EnumOption[] = [
  { value: "mexican", label: "Mexican" },
  { value: "puerto-rican", label: "Puerto Rican" },
  { value: "cuban", label: "Cuban" },
  { value: "other-hispanic-or-latino", label: "Other Hispanic or Latino" },
];
export const RACE_ROOT_OPTIONS: EnumOption[] = [
  { value: "american-indian-or-alaska-native", label: "American Indian or Alaska Native" },
  { value: "asian", label: "Asian" },
  { value: "black-or-african-american", label: "Black or African American" },
  { value: "native-hawaiian-or-pacific-islander", label: "Native Hawaiian or Other Pacific Islander" },
  { value: "white", label: "White" },
  { value: "not-provided", label: "I do not wish to provide this information" },
];
export const RACE_ASIAN_SUBOPTIONS: EnumOption[] = [
  { value: "asian-indian", label: "Asian Indian" },
  { value: "chinese", label: "Chinese" },
  { value: "filipino", label: "Filipino" },
  { value: "japanese", label: "Japanese" },
  { value: "korean", label: "Korean" },
  { value: "vietnamese", label: "Vietnamese" },
  { value: "other-asian", label: "Other Asian" },
];
export const RACE_PACIFIC_SUBOPTIONS: EnumOption[] = [
  { value: "native-hawaiian", label: "Native Hawaiian" },
  { value: "guamanian-or-chamorro", label: "Guamanian or Chamorro" },
  { value: "samoan", label: "Samoan" },
  { value: "other-pacific-islander", label: "Other Pacific Islander" },
];
export const SEX_OPTIONS: EnumOption[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "not-provided", label: "I do not wish to provide this information" },
];

// ---------------------------------------------------------------------------
// §A shape mirrors (fields verbatim; all draft-partial fields optional)
// ---------------------------------------------------------------------------

export interface Address {
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
  country?: string;
}

export interface MilitaryService {
  served: boolean;
  status?: string;
  projectedExpirationDate?: string;
}

export interface PreviousAddress {
  address: Address;
  housingStatus?: string;
  yearsAtAddress?: number;
  monthsAtAddress?: number;
  /** ISO YYYY-MM-DD — VR-132 interval start (optional). */
  fromDate?: string;
  /** ISO YYYY-MM-DD — VR-132 interval end (optional). */
  toDate?: string;
}

export interface EmploymentRecord {
  id?: string;
  employerName: string;
  employerAddress?: Address;
  employerPhone?: string;
  position?: string;
  startDate?: string;
  yearsInLineOfWork?: number;
  selfEmployed: boolean;
  ownershipShareGte25?: boolean;
  employedByFamilyOrParty?: boolean;
  baseMonthlyIncome?: number;
  overtime?: number;
  bonus?: number;
  commission?: number;
  militaryEntitlements?: number;
  otherMonthlyIncome?: number;
  selfEmployedMonthlyIncome?: number;
}

export interface PreviousEmploymentRecord {
  id?: string;
  employerName: string;
  employerAddress?: Address;
  position?: string;
  startDate: string;
  endDate: string;
  previousGrossMonthlyIncome?: number;
}

export interface OtherIncomeRecord {
  id?: string;
  source: string;
  monthlyAmount: number;
}

export interface Declarations {
  aOccupyPrimary?: boolean;
  a1PriorOwnership?: boolean;
  a1PropertyType?: string;
  a1TitleHeld?: string;
  bSellerRelationship?: boolean;
  cUndisclosedBorrowing?: boolean;
  cAmount?: number;
  d1OtherMortgageApplication?: boolean;
  d2NewCreditApplication?: boolean;
  ePriorityLien?: boolean;
  fCosignerUndisclosed?: boolean;
  gOutstandingJudgments?: boolean;
  hFederalDebtDelinquent?: boolean;
  iPartyToLawsuit?: boolean;
  jConveyedTitleInLieu?: boolean;
  kPreForeclosureSale?: boolean;
  lForeclosed?: boolean;
  mBankruptcy?: boolean;
  mBankruptcyType?: string;
}

export interface Demographics {
  ethnicity?: string[];
  ethnicityOtherDetail?: string;
  race?: string[];
  raceOtherDetails?: string[];
  sex?: string;
  collectionMethod?: string;
  visualObservation?: boolean;
}

export interface AssetRecord {
  id?: string;
  accountType: string;
  financialInstitution?: string;
  accountNumber?: string;
  accountNumberLast4?: string;
  cashOrMarketValue?: number;
  source?: string;
}

export interface OtherCreditRecord {
  id?: string;
  type: string;
  sourceOrDonor?: string;
  value?: number;
}

export interface ReoMortgage {
  creditor: string;
  accountNumber?: string;
  accountNumberLast4?: string;
  monthlyPayment?: number;
  unpaidBalance?: number;
  paidOffAtClosing?: boolean;
  mortgageType?: string;
}

export interface RealEstateOwnedRecord {
  id?: string;
  address: Address;
  propertyValue?: number;
  status?: string;
  intendedOccupancy?: string;
  monthlyInsuranceTaxesHoa?: number;
  monthlyRentalIncome?: number;
  netMonthlyRentalIncome?: number;
  mortgages?: ReoMortgage[];
}

export interface LiabilityRecord {
  id?: string;
  accountType: string;
  companyName?: string;
  accountNumber?: string;
  accountNumberLast4?: string;
  unpaidBalance?: number;
  monthlyPayment?: number;
  monthsLeft?: number;
  paidOffAtClosing?: boolean;
}

export interface OtherLiabilityRecord {
  id?: string;
  type: string;
  monthlyPayment: number;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
  county?: string;
  censusTract?: string;
}

export interface SubjectProperty {
  address?: Address;
  geocode?: GeoPoint;
  numberOfUnits?: number;
  propertyType?: string;
  occupancy?: string;
  mixedUse?: boolean;
  manufacturedHome?: boolean;
  /** VR-135 — collected only when manufacturedHome is true. */
  manufacturedHomeLandInterest?: string;
  estimatedValue?: number;
  expectedMonthlyRentalIncome?: number;
  titleNames?: string;
  titleManner?: string;
  estate?: string;
  leaseholdExpirationDate?: string;
  targetClosingDate?: string;
}

export interface OtherNewMortgage {
  creditor: string;
  lienType?: string;
  monthlyPayment?: number;
  amount?: number;
  creditLimit?: number;
}

export interface RefinanceDetails {
  originalCost?: number;
  existingLiens?: number;
  purposeOfRefinance?: string;
  improvementsDescription?: string;
  improvementsCost?: number;
}

export interface ProposedHousingExpense {
  firstMortgagePi?: number;
  subordinateLiens?: number;
  homeownersInsurance?: number;
  supplementalInsurance?: number;
  propertyTaxes?: number;
  mortgageInsurance?: number;
  hoaDues?: number;
  other?: number;
}

/** Step 7 wire payload — LoanDetails NESTS proposedHousingExpense (contract delta, REQ-030). */
export interface LoanDetailsSection {
  loanPurpose?: string;
  loanType?: string;
  amortizationType?: string;
  armInitialFixedMonths?: number;
  armAdjustmentMonths?: number;
  loanTermMonths?: number;
  requestedLoanAmount?: number;
  downPaymentAmount?: number;
  downPaymentSource?: string;
  otherNewMortgages?: OtherNewMortgage[];
  refinance?: RefinanceDetails;
  proposedHousingExpense?: ProposedHousingExpense;
}

export interface BorrowerIdentitySection {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  suffix?: string;
  alternateNames?: string[];
  ssn?: string;
  dateOfBirth?: string;
  citizenship?: string;
  maritalStatus?: string;
  dependentsCount?: number;
  dependentsAges?: string;
  homePhone?: string;
  cellPhone?: string;
  workPhone?: string;
  workPhoneExt?: string;
  email?: string;
  creditType?: string;
  militaryService?: MilitaryService;
}

export interface AddressHistorySection {
  currentAddress?: Address;
  housingStatus?: string;
  monthlyRent?: number;
  yearsAtAddress?: number;
  monthsAtAddress?: number;
  previousAddresses?: PreviousAddress[];
  mailingAddressDifferent?: boolean;
  mailingAddress?: Address;
}

export interface EmploymentSection {
  employmentType?: string;
  employments?: EmploymentRecord[];
  previousEmployments?: PreviousEmploymentRecord[];
  otherIncome?: OtherIncomeRecord[];
}

export interface AssetsSection {
  assets?: AssetRecord[];
  otherCredits?: OtherCreditRecord[];
  realEstateOwned?: RealEstateOwnedRecord[];
}

export interface LiabilitiesSection {
  liabilities?: LiabilityRecord[];
  otherLiabilities?: OtherLiabilityRecord[];
}

export interface BorrowerRecord {
  id: string;
  applicationId: string;
  ordinal: number;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  suffix?: string;
  alternateNames?: string[];
  ssnMasked?: string;
  ssnLast4?: string;
  dateOfBirthDisplay?: string;
  citizenship?: string;
  maritalStatus?: string;
  dependentsCount?: number;
  dependentsAges?: string;
  homePhone?: string;
  cellPhone?: string;
  workPhone?: string;
  workPhoneExt?: string;
  email?: string;
  creditType?: string;
  militaryService?: MilitaryService;
  currentAddress?: Address;
  housingStatus?: string;
  monthlyRent?: number;
  yearsAtAddress?: number;
  monthsAtAddress?: number;
  previousAddresses?: PreviousAddress[];
  mailingAddress?: Address;
  employmentType?: string;
  employments?: EmploymentRecord[];
  previousEmployments?: PreviousEmploymentRecord[];
  otherIncome?: OtherIncomeRecord[];
  declarations?: Declarations;
  demographics?: Demographics;
}

export interface SignatureInfo {
  id: string;
  borrowerId: string;
  mode: SignatureMode;
  signedAt: string;
  attestationVersion?: string;
  invalidatedAt?: string;
  demoBypass?: boolean;
}

export interface ApplicationData {
  assets?: AssetRecord[];
  otherCredits?: OtherCreditRecord[];
  realEstateOwned?: RealEstateOwnedRecord[];
  liabilities?: LiabilityRecord[];
  otherLiabilities?: OtherLiabilityRecord[];
  subjectProperty?: SubjectProperty;
  /** Stored WITHOUT the nested proposedHousingExpense group (see ApplicationData.proposedHousingExpense). */
  loan?: Omit<LoanDetailsSection, "proposedHousingExpense">;
  proposedHousingExpense?: ProposedHousingExpense;
}

export interface Application {
  id: string;
  applicationNumber: string;
  borrowerUserId: string;
  workflowState: WorkflowState;
  workflowStateLabel: string;
  previousStateForSuspend?: WorkflowState;
  priority: string;
  priorityOverride?: boolean;
  currentVersionNumber: number;
  versionStamp: number;
  submittedAt?: string;
  decidedAt?: string;
  outcome?: string;
  stateEnteredAt: string;
  slaPausedAt?: string;
  slaStatus?: string;
  overallSlaDaysRemaining?: number;
  revisionCycles: number;
  escalationRequired?: boolean;
  escalationCriteriaMet?: string[];
  dti?: number;
  ltv?: number;
  cltv?: number;
  ausStale?: boolean;
  isSeed?: boolean;
  copiedFromApplicationId?: string;
  assignedCaseworkerName?: string;
  decisionNotificationPending?: boolean;
  borrowers: BorrowerRecord[];
  data?: ApplicationData;
  signatures?: SignatureInfo[];
  /** Active bank links (CH-018) — absent when there are none. */
  bankLinks?: BankLinkInfo[];
  availableTransitions?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  section: WizardSection;
  borrowerOrdinal?: number;
  fieldPath: string;
  severity: IssueSeverity;
  message: string;
}

export interface StepStatus {
  step: number;
  status: StepCompletion;
}

export interface ValidationSummary {
  issues: ValidationIssue[];
  completionPct: number;
  stepStatuses: StepStatus[];
}

export interface SectionSaveResponse {
  savedAt: string;
  versionStamp: number;
  dti?: number;
  ltv?: number;
  cltv?: number;
  issues?: ValidationIssue[];
  signatureInvalidated?: boolean;
  staleCopyAdvisories?: string[];
}

export interface BorrowerIdentityOwn {
  ordinal: number;
  identity: BorrowerIdentitySection;
}

export interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  satisfied: boolean;
  documentId?: string;
  documentStatus?: DocumentStatus;
}

export interface DocumentVersionInfo {
  id: string;
  versionNumber: number;
  originalFileName: string;
  sniffedContentType: string;
  sizeBytes: number;
}

export interface AppDocument {
  id: string;
  applicationId: string;
  documentType: string;
  description?: string;
  checklistItemKey?: string;
  status: DocumentStatus;
  statusReason?: string;
  currentVersionId: string;
  currentVersionNumber: number;
  jobStatus?: DocumentJobStatus;
  versions?: DocumentVersionInfo[];
  uploadedByName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentListResponse {
  checklist: ChecklistItem[];
  documents: AppDocument[];
}

export interface InstitutionInfo {
  id: string;
  name: string;
}

export interface LinkedAccountInfo {
  externalAccountId: string;
  accountType: string;
  institution: string;
  last4: string;
  balance: number;
}

export interface IncomeEvidence {
  employerName: string;
  employerMatch: boolean;
  averageMonthlyDeposit: number;
}

export interface BankLinkSession {
  linkId: string;
  accounts: LinkedAccountInfo[];
  incomeEvidence?: IncomeEvidence[];
}

/**
 * contracts §A BankLinkInfo (CH-018, REQ-039). Carried on Application.bankLinks
 * for ACTIVE links only — an unlinked link is ABSENT from the wire. `id` is the
 * `:linkId` of DELETE /api/applications/:id/bank-links/:linkId (BUG-28).
 */
export interface BankLinkInfo {
  id: string;
  institution: string;
  linkedAt: string;
  importedAccountCount: number;
}

export interface AddressSuggestion {
  formatted: string;
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
}

/** contracts §A ApplicationNote — the fields this surface reads. */
export interface ApplicationNote {
  id: string;
  type: string;
  content: string;
  authorDisplayName?: string;
  authorRole?: string;
  createdAt: string;
}

export interface NotePage {
  rows: ApplicationNote[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BorrowerApplicationRow {
  id: string;
  applicationNumber: string;
  createdAt: string;
  submittedAt?: string;
  workflowState: WorkflowState;
  workflowStateLabel: string;
  [key: string]: unknown;
}

/** States in which the Borrower may edit / save / sign (REQ-035, §4.2.8). */
export const EDITABLE_STATES: readonly WorkflowState[] = ["draft", "revision_requested"];

/** Active underwriting states (§4.2.2 one-active rule: states 2-13). */
export function isActiveUnderwritingState(state: WorkflowState): boolean {
  return state !== "draft" && state !== "withdrawn" && state !== "declined_by_borrower";
}

export const STEP_TITLES: Record<number, string> = {
  1: "Borrower Identity",
  2: "Address History",
  3: "Employment & Income",
  4: "Assets & Real Estate Owned",
  5: "Liabilities",
  6: "Subject Property",
  7: "Loan Details",
  8: "Declarations",
  9: "Demographic Information",
  10: "Documents, Review & Signature",
};

/** Wizard step → WizardSection (step 10 has no data section). */
export const STEP_SECTION: Record<number, WizardSection | null> = {
  1: "identity",
  2: "address-history",
  3: "employment-income",
  4: "assets-reo",
  5: "liabilities",
  6: "subject-property",
  7: "loan-details",
  8: "declarations",
  9: "demographics",
  10: null,
};

/** Per-borrower steps (co-borrower tabs shown here — §4.2.5). */
export const PER_BORROWER_STEPS: readonly number[] = [1, 2, 3, 8, 9];
