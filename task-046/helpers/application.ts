/**
 * Application fixtures, built entirely through contracted endpoints.
 *
 * `buildSubmittableDraft` fills every §4.2.4-required wizard section so the
 * submission gate (T1) passes; `driveTo` walks the workflow map to any state a
 * test needs. Nothing here reads the database or the schema.
 */
import { randomUUID } from "node:crypto";
import { GET, POST, PUT, expectOk, type ApiResult, type Session } from "./http.js";

export interface BorrowerRecord {
  id: string;
  applicationId: string;
  ordinal: number;
  firstName?: string;
  lastName?: string;
  ssnMasked?: string;
  ssnLast4?: string;
  dateOfBirthDisplay?: string;
  [key: string]: unknown;
}

export interface Application {
  id: string;
  applicationNumber: string;
  borrowerUserId: string;
  workflowState: string;
  workflowStateLabel: string;
  previousStateForSuspend?: string;
  priority: string;
  currentVersionNumber: number;
  versionStamp: number;
  submittedAt?: string;
  decidedAt?: string;
  outcome?: "approved" | "denied";
  stateEnteredAt: string;
  slaStatus?: string;
  slaPausedAt?: string;
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
  data?: Record<string, unknown>;
  signatures?: Array<{ id: string; borrowerId: string; mode: string; invalidatedAt?: string }>;
  availableTransitions?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SectionSaveResponse {
  savedAt: string;
  versionStamp: number;
  dti?: number;
  ltv?: number;
  cltv?: number;
  issues?: Array<{ section: string; borrowerOrdinal?: number; fieldPath: string; severity: string; message: string }>;
  signatureInvalidated?: boolean;
  staleCopyAdvisories?: string[];
}

export interface ValidationSummary {
  issues: Array<{ section: string; borrowerOrdinal?: number; fieldPath: string; severity: string; message: string }>;
  completionPct: number;
  stepStatuses: Array<{ step: number; status: string }>;
}

/** Financial shape of the fixture — lets tests target specific DTI/LTV values. */
export interface DraftShape {
  firstName?: string;
  lastName?: string;
  /** Full ###-##-#### — last digit drives the credit simulation scenario. */
  ssn?: string;
  dateOfBirth?: string;
  zip?: string;
  estimatedValue?: number;
  requestedLoanAmount?: number;
  baseMonthlyIncome?: number;
  otherIncome?: Array<{ source: string; monthlyAmount: number }>;
  liabilityMonthlyPayment?: number;
  otherLiabilityMonthlyPayment?: number;
  housingExpense?: Record<string, number>;
  loanType?: string;
  loanPurpose?: string;
  occupancy?: string;
  propertyType?: string;
  subordinateLienAmount?: number;
  reoNetMonthlyRentalIncome?: number;
  selfEmployedMonthlyIncome?: number;
  overtime?: number;
  bonus?: number;
  commission?: number;
  militaryEntitlements?: number;
  otherMonthlyIncome?: number;
}

/**
 * A unique SSN in the 900-999 demo area range whose LAST DIGIT is the credit
 * simulation scenario key (§6.3.1). Uniqueness matters: a blind-index match against
 * another borrower's application raises a duplicate-SSN FraudFlag (XBR-021), and an
 * open high-severity flag blocks T15 (XBR-008).
 */
export function makeSsn(lastDigit: number): string {
  const area = 900 + Math.floor(Math.random() * 100);
  const group = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  const serialHead = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `${area}-${group}-${serialHead}${lastDigit % 10}`;
}

/** DOB for an adult applicant (well over 18 at application date). */
export const ADULT_DOB = "1985-06-15";

export async function createDraft(borrower: Session, extra: Record<string, unknown> = {}): Promise<Application> {
  const result = await POST<Application>("/api/applications", {
    session: borrower,
    body: { requestToken: randomUUID(), ...extra },
  });
  return expectOk(result, "POST /api/applications", 201);
}

export async function getApplication(session: Session, id: string): Promise<Application> {
  const path = `/api/applications/${id}`;
  const result = await GET<Application>(path, { session });
  return expectOk(result, `GET ${path}`, 200);
}

export async function saveSection(
  borrower: Session,
  applicationId: string,
  section: string,
  payload: Record<string, unknown>,
  versionStamp: number,
  borrowerOrdinal?: number,
): Promise<ApiResult<SectionSaveResponse>> {
  const path = `/api/applications/${applicationId}/sections/${section}`;
  const body: Record<string, unknown> = { versionStamp, section, ...payload };
  if (borrowerOrdinal !== undefined) body.borrowerOrdinal = borrowerOrdinal;
  return PUT<SectionSaveResponse>(path, { session: borrower, body });
}

const ALL_DECLARATIONS_NO = {
  aOccupyPrimary: true,
  a1PriorOwnership: false,
  bSellerRelationship: false,
  cUndisclosedBorrowing: false,
  d1OtherMortgageApplication: false,
  d2NewCreditApplication: false,
  ePriorityLien: false,
  fCosignerUndisclosed: false,
  gOutstandingJudgments: false,
  hFederalDebtDelinquent: false,
  iPartyToLawsuit: false,
  jConveyedTitleInLieu: false,
  kPreForeclosureSale: false,
  lForeclosed: false,
  mBankruptcy: false,
};

/**
 * Fills every wizard section of a fresh draft with valid data.
 * Returns the application after the last save (stamp is current).
 */
export async function fillDraft(
  borrower: Session,
  application: Application,
  shape: DraftShape = {},
): Promise<Application> {
  const id = application.id;
  let stamp = application.versionStamp;

  const run = async (section: string, payload: Record<string, unknown>, ordinal?: number): Promise<void> => {
    const result = await saveSection(borrower, id, section, payload, stamp, ordinal);
    const body = expectOk(result, `PUT sections/${section}`, 200);
    stamp = body.versionStamp;
  };

  const zip = shape.zip ?? "43215";
  const estimatedValue = shape.estimatedValue ?? 400000;
  const requestedLoanAmount = shape.requestedLoanAmount ?? 300000;

  await run(
    "identity",
    {
      identity: {
        firstName: shape.firstName ?? "Fixture",
        lastName: shape.lastName ?? "Borrower",
        ssn: shape.ssn ?? makeSsn(1),
        dateOfBirth: shape.dateOfBirth ?? ADULT_DOB,
        citizenship: "us-citizen",
        maritalStatus: "unmarried",
        dependentsCount: 0,
        cellPhone: "614-555-0101",
        email: borrower.email,
        creditType: "individual",
        militaryService: { served: false },
      },
    },
    1,
  );

  await run(
    "address-history",
    {
      addressHistory: {
        currentAddress: { street: "100 Test Way", city: "Columbus", state: "OH", zip, county: "Franklin" },
        housingStatus: "rent",
        monthlyRent: 1500,
        yearsAtAddress: 5,
        monthsAtAddress: 0,
        mailingAddressDifferent: false,
      },
    },
    1,
  );

  await run(
    "employment-income",
    {
      employmentIncome: {
        employmentType: "employed",
        employments: [
          {
            employerName: "Test Employer LLC",
            employerAddress: { street: "1 Commerce Plz", city: "Columbus", state: "OH", zip: "43215" },
            employerPhone: "614-555-0199",
            position: "Analyst",
            startDate: "2016-03-01",
            yearsInLineOfWork: 9,
            selfEmployed: false,
            employedByFamilyOrParty: false,
            baseMonthlyIncome: shape.baseMonthlyIncome ?? 9000,
            overtime: shape.overtime ?? 0,
            bonus: shape.bonus ?? 0,
            commission: shape.commission ?? 0,
            militaryEntitlements: shape.militaryEntitlements ?? 0,
            otherMonthlyIncome: shape.otherMonthlyIncome ?? 0,
            selfEmployedMonthlyIncome: shape.selfEmployedMonthlyIncome ?? 0,
          },
        ],
        otherIncome: shape.otherIncome ?? [],
      },
    },
    1,
  );

  const reo =
    shape.reoNetMonthlyRentalIncome === undefined
      ? []
      : [
          {
            address: { street: "22 Rental Rd", city: "Columbus", state: "OH", zip: "43201" },
            propertyValue: 250000,
            status: "retained",
            intendedOccupancy: "investment-property",
            monthlyInsuranceTaxesHoa: 400,
            monthlyRentalIncome: shape.reoNetMonthlyRentalIncome + 400,
            netMonthlyRentalIncome: shape.reoNetMonthlyRentalIncome,
            mortgages: [],
          },
        ];

  await run("assets-reo", {
    assetsReo: {
      assets: [
        {
          accountType: "checking",
          financialInstitution: "Test Bank",
          accountNumber: "123456789012",
          cashOrMarketValue: 120000,
          source: "manual",
        },
      ],
      otherCredits: [],
      realEstateOwned: reo,
    },
  });

  await run("liabilities", {
    liabilities: {
      liabilities: [
        {
          accountType: "installment",
          companyName: "Test Auto Finance",
          accountNumber: "998877665544",
          unpaidBalance: 12000,
          monthlyPayment: shape.liabilityMonthlyPayment ?? 350,
          monthsLeft: 36,
          paidOffAtClosing: false,
        },
      ],
      otherLiabilities:
        shape.otherLiabilityMonthlyPayment === undefined
          ? []
          : [{ type: "child-support", monthlyPayment: shape.otherLiabilityMonthlyPayment }],
    },
  });

  await run("subject-property", {
    subjectProperty: {
      address: { street: "500 Subject St", city: "Columbus", state: "OH", zip, county: "Franklin" },
      numberOfUnits: 1,
      propertyType: shape.propertyType ?? "single-family-detached",
      occupancy: shape.occupancy ?? "primary-residence",
      mixedUse: false,
      manufacturedHome: false,
      estimatedValue,
      titleNames: `${shape.firstName ?? "Fixture"} ${shape.lastName ?? "Borrower"}`,
      titleManner: "sole-ownership",
      estate: "fee-simple",
      targetClosingDate: "2027-01-15",
    },
  });

  await run("loan-details", {
    loanDetails: {
      loanPurpose: shape.loanPurpose ?? "purchase",
      loanType: shape.loanType ?? "conventional",
      amortizationType: "fixed",
      loanTermMonths: 360,
      requestedLoanAmount,
      downPaymentAmount: Math.max(estimatedValue - requestedLoanAmount, 0),
      downPaymentSource: "checking",
      otherNewMortgages:
        shape.subordinateLienAmount === undefined
          ? []
          : [
              {
                creditor: "Test Second Lien Co",
                lienType: "subordinate-lien",
                monthlyPayment: 200,
                amount: shape.subordinateLienAmount,
                creditLimit: shape.subordinateLienAmount,
              },
            ],
      proposedHousingExpense: {
        firstMortgagePi: 1900,
        subordinateLiens: 0,
        homeownersInsurance: 110,
        supplementalInsurance: 0,
        propertyTaxes: 400,
        mortgageInsurance: 0,
        hoaDues: 0,
        other: 0,
        ...(shape.housingExpense ?? {}),
      },
    },
  });

  await run("declarations", { declarations: { ...ALL_DECLARATIONS_NO } }, 1);

  await run(
    "demographics",
    {
      demographics: {
        ethnicity: ["not-hispanic-or-latino"],
        race: ["white"],
        sex: "not-provided",
      },
    },
    1,
  );

  return getApplication(borrower, id);
}

/** Signs for every borrower on the application (demo attestation mode). */
export async function signAll(borrower: Session, application: Application): Promise<Application> {
  for (const record of application.borrowers) {
    const path = `/api/applications/${application.id}/signatures`;
    const result = await POST(path, {
      session: borrower,
      body: { borrowerId: record.id, mode: "demo", attestationAccepted: true },
    });
    expectOk(result, `POST ${path}`, 201);
  }
  return getApplication(borrower, application.id);
}

export interface TransitionBody {
  toState: string;
  versionStamp?: number;
  note?: string;
  reason?: string;
  recommendation?: string;
}

export async function transition(
  session: Session,
  applicationId: string,
  body: TransitionBody,
  stampOverride?: number,
): Promise<ApiResult<Application>> {
  const path = `/api/applications/${applicationId}/transition`;
  let versionStamp = body.versionStamp ?? stampOverride;
  if (versionStamp === undefined) {
    versionStamp = (await getApplication(session, applicationId)).versionStamp;
  }
  return POST<Application>(path, { session, body: { ...body, versionStamp } });
}

export async function transitionOk(
  session: Session,
  applicationId: string,
  body: TransitionBody,
): Promise<Application> {
  const result = await transition(session, applicationId, body);
  return expectOk(result, `POST transition → ${body.toState}`, 200);
}

/** Fully-populated, signed, submittable draft owned by `borrower`. */
export async function buildSubmittableDraft(borrower: Session, shape: DraftShape = {}): Promise<Application> {
  const draft = await createDraft(borrower);
  const filled = await fillDraft(borrower, draft, shape);
  return signAll(borrower, filled);
}

/** Draft → application_received (T1). */
export async function submit(borrower: Session, shape: DraftShape = {}): Promise<Application> {
  const draft = await buildSubmittableDraft(borrower, shape);
  return transitionOk(borrower, draft.id, { toState: "application_received", versionStamp: draft.versionStamp });
}

export async function validation(borrower: Session, applicationId: string): Promise<ValidationSummary> {
  const path = `/api/applications/${applicationId}/validation`;
  const result = await GET<ValidationSummary>(path, { session: borrower });
  return expectOk(result, `GET ${path}`, 200);
}

export async function claim(staff: Session, applicationId: string): Promise<ApiResult<unknown>> {
  const path = `/api/applications/${applicationId}/claim`;
  return POST(path, { session: staff });
}

/** §A UnderwritingResultInfo (subset the suite asserts on). */
export interface UnderwritingResult {
  id: string;
  applicationId: string;
  checkType: string;
  status: string;
  isStale?: boolean;
  riskBadge?: string;
  summary?: string;
  error?: string;
  credit?: Record<string, unknown>;
  income?: Record<string, unknown>;
  avm?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  aus?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function runCheck(
  staff: Session,
  applicationId: string,
  checkType: string,
): Promise<ApiResult<UnderwritingResult>> {
  const path = `/api/applications/${applicationId}/checks/${checkType}`;
  return POST<UnderwritingResult>(path, { session: staff });
}

export async function listChecks(staff: Session, applicationId: string): Promise<UnderwritingResult[]> {
  const path = `/api/applications/${applicationId}/checks`;
  const result = await GET<{ rows?: UnderwritingResult[] } | UnderwritingResult[]>(path, { session: staff });
  const body = expectOk(result, `GET ${path}`, 200);
  return Array.isArray(body) ? body : (body.rows ?? []);
}

/** Polls the check list until `checkType` leaves `running` (ASYNC-005). */
export async function awaitCheck(
  staff: Session,
  applicationId: string,
  checkType: string,
  timeoutMs = 60000,
): Promise<UnderwritingResult> {
  const deadline = Date.now() + timeoutMs;
  let last: UnderwritingResult | undefined;
  while (Date.now() < deadline) {
    const rows = await listChecks(staff, applicationId);
    last = rows.find((row) => row.checkType === checkType);
    if (last && last.status !== "running") return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`check ${checkType} did not settle in ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
}

export const FOUR_CHECKS = ["credit", "income", "avm", "pricing"] as const;

/** Runs the given checks concurrently and waits for each to leave `running`. */
export async function runChecks(staff: Session, applicationId: string, checkTypes: readonly string[]): Promise<void> {
  for (const checkType of checkTypes) {
    const started = await runCheck(staff, applicationId, checkType);
    expectOk(started, `POST checks/${checkType}`, 202);
  }
  for (const checkType of checkTypes) {
    const settled = await awaitCheck(staff, applicationId, checkType);
    if (settled.status !== "completed") {
      throw new Error(`check ${checkType} finished ${settled.status}: ${JSON.stringify(settled)}`);
    }
  }
}

/**
 * Runs the four §7.7 checks plus AUS — the full T11 precondition set
 * (four checks completed/non-errored/non-stale, AUS result recorded).
 */
export async function runAllChecks(staff: Session, applicationId: string): Promise<void> {
  await runChecks(staff, applicationId, FOUR_CHECKS);
  await runChecks(staff, applicationId, ["aus"]);
}

export interface DocumentInfo {
  id: string;
  applicationId: string;
  documentType: string;
  status: string;
  currentVersionId: string;
  currentVersionNumber: number;
  jobStatus?: string;
  versions?: Array<{ id: string; versionNumber: number; originalFileName: string; sniffedContentType: string; sizeBytes: number }>;
}

/** Minimal valid PDF bytes — magic-byte sniffing sees %PDF-. */
export function pdfBytes(sizeBytes = 2048): Buffer {
  const header = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary");
  const trailer = Buffer.from("\n%%EOF\n", "binary");
  const padLength = Math.max(sizeBytes - header.length - trailer.length, 0);
  return Buffer.concat([header, Buffer.alloc(padLength, 0x20), trailer]);
}

export function pngBytes(sizeBytes = 1024): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(Math.max(sizeBytes - header.length, 0), 0x00)]);
}

export async function uploadDocument(
  session: Session,
  applicationId: string,
  fileName: string,
  bytes: Buffer,
  documentType: string,
  description?: string,
): Promise<ApiResult<DocumentInfo>> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), fileName);
  form.append("documentType", documentType);
  if (description !== undefined) form.append("description", description);
  const path = `/api/applications/${applicationId}/documents`;
  return POST<DocumentInfo>(path, { session, form });
}

export async function listDocuments(session: Session, applicationId: string): Promise<DocumentInfo[]> {
  const path = `/api/applications/${applicationId}/documents`;
  const result = await GET<{ documents?: DocumentInfo[]; rows?: DocumentInfo[] }>(path, { session });
  const body = expectOk(result, `GET ${path}`, 200) as Record<string, unknown>;
  const documents = (body.documents ?? body.rows) as DocumentInfo[] | undefined;
  return documents ?? [];
}
