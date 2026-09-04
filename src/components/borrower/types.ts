// Client-side wire-shape mirrors for the borrower surfaces (task-017).
// EVERY field name and enum literal below is copied verbatim from
// contracts.json (§A shared shapes) — do not rename or extend.

// ---------------------------------------------------------------------------
// Enums (contracts.json enums.*)
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

export type Outcome = "approved" | "denied";

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

export type DocumentStatus = "pending" | "accepted" | "insufficient" | "waived";
export type DocumentJobStatus = "queued" | "processing" | "completed" | "failed";
export type DocumentType =
  | "w2"
  | "pay-stub"
  | "bank-statement"
  | "tax-return-1040"
  | "government-id"
  | "gift-letter"
  | "purchase-agreement"
  | "homeowners-insurance-quote"
  | "other";

export type NotificationChannelPreference = "email" | "sms" | "both";

/** The 9 copyable sections (§4.2.3) in wizard order, with display labels. */
export const WIZARD_SECTIONS: { section: WizardSection; label: string }[] = [
  { section: "identity", label: "Identity" },
  { section: "address-history", label: "Address History" },
  { section: "employment-income", label: "Employment & Income" },
  { section: "assets-reo", label: "Assets & Real Estate Owned" },
  { section: "liabilities", label: "Liabilities" },
  { section: "subject-property", label: "Subject Property" },
  { section: "loan-details", label: "Loan Details" },
  { section: "declarations", label: "Declarations" },
  { section: "demographics", label: "Demographics" },
];

export function sectionLabel(section: string): string {
  return WIZARD_SECTIONS.find((s) => s.section === section)?.label ?? section;
}

// ---------------------------------------------------------------------------
// Dashboard list (§A BorrowerApplicationList)
// ---------------------------------------------------------------------------

export interface BorrowerApplicationRow {
  id: string;
  applicationNumber: string;
  createdAt: string;
  submittedAt?: string;
  workflowState: WorkflowState;
  workflowStateLabel: string;
  loanAmount?: number;
  propertyCityState?: string;
  outcome?: Outcome;
  availableActions: string[];
}

export interface BorrowerSummaryCards {
  total: number;
  draft: number;
  inUnderwriting: number;
  approved: number;
  denied: number;
  withdrawn: number;
}

export interface BorrowerApplicationList {
  rows: BorrowerApplicationRow[];
  cards: BorrowerSummaryCards;
  page: number;
  pageSize: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Application detail (§A Application — the subset the view page reads)
// ---------------------------------------------------------------------------

export interface AddressWire {
  street?: string;
  unit?: string;
  city?: string;
  state?: string;
  zip?: string;
  county?: string;
  country?: string;
}

export interface EmploymentRecordWire {
  id?: string;
  employerName?: string;
  position?: string;
  startDate?: string;
  selfEmployed?: boolean;
  baseMonthlyIncome?: number;
  selfEmployedMonthlyIncome?: number;
}

export interface OtherIncomeRecordWire {
  id?: string;
  source?: string;
  monthlyAmount?: number;
}

export interface BorrowerRecordWire {
  id: string;
  applicationId: string;
  ordinal: number;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  suffix?: string;
  ssnMasked?: string;
  dateOfBirthDisplay?: string;
  citizenship?: string;
  maritalStatus?: string;
  dependentsCount?: number;
  homePhone?: string;
  cellPhone?: string;
  workPhone?: string;
  email?: string;
  creditType?: string;
  currentAddress?: AddressWire;
  housingStatus?: string;
  monthlyRent?: number;
  yearsAtAddress?: number;
  monthsAtAddress?: number;
  mailingAddress?: AddressWire;
  employmentType?: string;
  employments?: EmploymentRecordWire[];
  otherIncome?: OtherIncomeRecordWire[];
  declarations?: Record<string, unknown>;
  demographics?: {
    ethnicity?: string[];
    race?: string[];
    sex?: string;
  };
}

export interface AssetRecordWire {
  id?: string;
  accountType?: string;
  financialInstitution?: string;
  accountNumberLast4?: string;
  cashOrMarketValue?: number;
  source?: string;
}

export interface LiabilityRecordWire {
  id?: string;
  accountType?: string;
  companyName?: string;
  accountNumberLast4?: string;
  unpaidBalance?: number;
  monthlyPayment?: number;
}

export interface OtherLiabilityRecordWire {
  id?: string;
  type?: string;
  monthlyPayment?: number;
}

export interface RealEstateOwnedRecordWire {
  id?: string;
  address?: AddressWire;
  propertyValue?: number;
  status?: string;
}

export interface SubjectPropertyWire {
  address?: AddressWire;
  numberOfUnits?: number;
  propertyType?: string;
  occupancy?: string;
  estimatedValue?: number;
  targetClosingDate?: string;
}

export interface LoanDetailsWire {
  loanPurpose?: string;
  loanType?: string;
  amortizationType?: string;
  loanTermMonths?: number;
  requestedLoanAmount?: number;
  downPaymentAmount?: number;
  downPaymentSource?: string;
}

export interface ApplicationDataWire {
  assets?: AssetRecordWire[];
  otherCredits?: { id?: string; type?: string; value?: number }[];
  realEstateOwned?: RealEstateOwnedRecordWire[];
  liabilities?: LiabilityRecordWire[];
  otherLiabilities?: OtherLiabilityRecordWire[];
  subjectProperty?: SubjectPropertyWire;
  loan?: LoanDetailsWire;
}

export interface ApplicationWire {
  id: string;
  applicationNumber: string;
  borrowerUserId: string;
  workflowState: WorkflowState;
  workflowStateLabel: string;
  previousStateForSuspend?: WorkflowState;
  priority: string;
  currentVersionNumber: number;
  versionStamp: number;
  submittedAt?: string;
  decidedAt?: string;
  outcome?: Outcome;
  stateEnteredAt: string;
  slaStatus?: string;
  overallSlaDaysRemaining?: number;
  revisionCycles: number;
  dti?: number;
  ltv?: number;
  cltv?: number;
  copiedFromApplicationId?: string;
  assignedCaseworkerName?: string;
  decisionNotificationPending?: boolean;
  borrowers: BorrowerRecordWire[];
  data?: ApplicationDataWire;
  availableTransitions?: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Workflow history / notes / versions (§A)
// ---------------------------------------------------------------------------

export interface WorkflowHistoryInfo {
  id: string;
  fromState: WorkflowState;
  fromStateLabel: string;
  toState: WorkflowState;
  toStateLabel: string;
  actorDisplayName?: string;
  actorRole: string;
  note?: string;
  versionNumber?: number;
  createdAt: string;
}

export interface WorkflowHistoryPage {
  rows: WorkflowHistoryInfo[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApplicationNote {
  id: string;
  applicationId: string;
  authorDisplayName: string;
  authorRole: string;
  type: "internal" | "formal" | "chatter";
  content: string;
  relatedTransitionId?: string;
  createdAt: string;
}

export interface NotePage {
  rows: ApplicationNote[];
  page: number;
  pageSize: number;
  total: number;
}

export interface VersionInfo {
  id: string;
  versionNumber: number;
  reason: "initial-submission" | "resubmission";
  createdAt: string;
  isCurrent: boolean;
}

export interface VersionPage {
  rows: VersionInfo[];
  page: number;
  pageSize: number;
  total: number;
}

export interface FieldChange {
  fieldPath: string;
  changeType: "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

export interface SectionDiff {
  section: WizardSection;
  changes: FieldChange[];
}

export interface VersionDiffResponse {
  fromVersion: number;
  toVersion: number;
  sections: SectionDiff[];
}

// ---------------------------------------------------------------------------
// Documents (§A Document / DocumentListResponse / DocumentRequestInfo)
// ---------------------------------------------------------------------------

export interface DocumentVersionInfoWire {
  id: string;
  versionNumber: number;
  originalFileName: string;
  sniffedContentType: string;
  sizeBytes: number;
  uploadedByName?: string;
  createdAt: string;
}

export interface DocumentWire {
  id: string;
  applicationId: string;
  documentType: DocumentType;
  description?: string;
  checklistItemKey?: string;
  status: DocumentStatus;
  statusReason?: string;
  currentVersionId: string;
  currentVersionNumber: number;
  jobStatus?: DocumentJobStatus;
  versions?: DocumentVersionInfoWire[];
  uploadedByName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistItemWire {
  key: string;
  label: string;
  required: boolean;
  satisfied: boolean;
  documentId?: string;
  documentStatus?: DocumentStatus;
}

export interface DocumentListResponse {
  checklist: ChecklistItemWire[];
  documents: DocumentWire[];
}

export interface DocumentRequestInfo {
  id: string;
  applicationId: string;
  documentType: DocumentType;
  reason: string;
  requestedByName?: string;
  fulfilledByDocumentId?: string;
  createdAt: string;
}

export interface DocumentRequestList {
  rows: DocumentRequestInfo[];
}

// ---------------------------------------------------------------------------
// Profile (§A UserProfile + requests)
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string;
  email: string;
  pendingEmail?: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: "BORROWER" | "CASEWORKER" | "SUPERVISOR";
  notificationChannel?: NotificationChannelPreference;
  smsVerified?: boolean;
  mfaEnrolled: boolean;
  passwordChangedAt?: string;
}

export interface MfaEnrollInit {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}
