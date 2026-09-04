// URLA 2020 submission-gate validation engine — PURE (task-011).
//
// THE single authority for required-field validation (RFP §4.2.4 "req." flags,
// steps 1-10) plus the §E-preamble conditional requirements:
//   - monthly rent iff renting
//   - 24-month address AND employment coverage
//   - REO required iff declaration A.1 yes or occupancy not primary
//   - refinance details iff refinance purpose; purchase fields iff purchase
//   - leasehold expiration iff leasehold estate
//   - ARM periods iff adjustable amortization
//   - at least one asset; at least one phone
//   - all 15 declarations answered per borrower
//   - LTV > block% is an ERROR; LTV > warn% is a WARNING (severity per REQ-036)
//   - age >= 18 at application date (INV-025)
// Consumers: GET /api/applications/:id/validation (task-011) and the T1/T36
// transition gate (task-019 via src/lib/services/submission.ts).
//
// Pure-function rules: no Prisma, no fetch, no Date.now — the caller passes the
// evaluation date. Callers decrypt DOB before calling (this module never sees
// ciphertext); SSN presence arrives as a boolean.
//
// Wire shapes (ValidationIssue / StepStatus / ValidationSummary) use the exact
// contracts.json field names and enum literals.

// ---------------------------------------------------------------------------
// Contract wire shapes (§A, verbatim field names)
// ---------------------------------------------------------------------------

/** contracts.json enums.WizardSection, verbatim. */
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

/** contracts.json enums.IssueSeverity, verbatim. */
export type IssueSeverity = "error" | "warning";

/** contracts.json enums.StepCompletion, verbatim. */
export type StepCompletion = "complete" | "in-progress" | "not-started";

/** contracts.md §A ValidationIssue — exact field names. */
export interface ValidationIssue {
  section: WizardSection;
  borrowerOrdinal?: number;
  fieldPath: string;
  severity: IssueSeverity;
  message: string;
}

/** contracts.md §A StepStatus. */
export interface StepStatus {
  step: number;
  status: StepCompletion;
}

/** contracts.md §A ValidationSummary. */
export interface ValidationSummary {
  issues: ValidationIssue[];
  completionPct: number;
  stepStatuses: StepStatus[];
}

/** Wizard step number → WizardSection (§4.2.4). Step 10 has no data section. */
export const STEP_SECTIONS: Record<number, WizardSection | null> = {
  1: "identity",
  2: "address-history",
  3: "employment-income",
  4: "assets-reo",
  5: "liabilities",
  6: "subject-property",
  7: "loan-details",
  8: "declarations",
  9: "demographics",
  10: null, // Documents, Review & Signature
};

/** Per-borrower sections (VR-058). */
export const PER_BORROWER_SECTIONS: readonly WizardSection[] = [
  "identity",
  "address-history",
  "employment-income",
  "declarations",
  "demographics",
];

// ---------------------------------------------------------------------------
// Input shapes — plain data the service layer maps live rows onto
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

export interface BorrowerValidationInput {
  ordinal: number;
  firstName?: string | null;
  lastName?: string | null;
  /** True when an encrypted SSN is stored for this borrower. */
  hasSsn: boolean;
  /** Decrypted ISO 8601 date (YYYY-MM-DD) or null — caller decrypts. */
  dateOfBirth?: string | null;
  citizenship?: string | null;
  maritalStatus?: string | null;
  homePhone?: string | null;
  cellPhone?: string | null;
  workPhone?: string | null;
  email?: string | null;
  creditType?: string | null;
  /** MilitaryService JSON document ({ served, status, projectedExpirationDate }). */
  militaryService?: Rec | null;
  /** Address JSON document. */
  currentAddress?: Rec | null;
  housingStatus?: string | null;
  monthlyRent?: number | null;
  yearsAtAddress?: number | null;
  monthsAtAddress?: number | null;
  /** PreviousAddress[] JSON documents. */
  previousAddresses?: readonly Rec[] | null;
  employmentType?: string | null;
  /** EmploymentRecord[] JSON documents. */
  employments?: readonly Rec[] | null;
  /** PreviousEmploymentRecord[] JSON documents. */
  previousEmployments?: readonly Rec[] | null;
  otherIncome?: readonly Rec[] | null;
  /** Declarations JSON document. */
  declarations?: Rec | null;
  /** Demographics JSON document. */
  demographics?: Rec | null;
}

export interface ApplicationDataValidationInput {
  assets?: readonly Rec[] | null;
  otherCredits?: readonly Rec[] | null;
  realEstateOwned?: readonly Rec[] | null;
  liabilities?: readonly Rec[] | null;
  otherLiabilities?: readonly Rec[] | null;
  subjectProperty?: Rec | null;
  loan?: Rec | null;
  proposedHousingExpense?: Rec | null;
}

export interface ApplicationValidationInput {
  borrowers: readonly BorrowerValidationInput[];
  data: ApplicationDataValidationInput | null;
  /** Server-computed LTV percent (shared qualification module) or null. */
  ltv: number | null;
  /** Live SystemConfig thresholds (never hardcoded — INV-024). */
  ltvWarningPercent: number;
  ltvSubmissionBlockPercent: number;
  /** Application date for the age >= 18 check (INV-025) — ISO string or Date. */
  applicationDate: string | Date;
  /**
   * Step-10 signature state: per borrower ordinal, whether a CURRENTLY-VALID
   * signature exists (invalidatedAt null AND dataHash matches — INV-029).
   */
  signedOrdinals: readonly number[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function arr(v: readonly Rec[] | null | undefined): readonly Rec[] {
  return Array.isArray(v) ? v : [];
}

/** Age in whole years at `at` for an ISO YYYY-MM-DD birth date. */
export function ageAt(dateOfBirth: string, at: string | Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ref = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(ref.getTime())) return null;
  let age = ref.getUTCFullYear() - y;
  const beforeBirthday =
    ref.getUTCMonth() + 1 < mo || (ref.getUTCMonth() + 1 === mo && ref.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

// ---------------------------------------------------------------------------
// 24-month coverage — the §E "union with no gap" rule (VR-132 / VR-133)
// ---------------------------------------------------------------------------

/** The trailing-window length both coverage rules measure (§E preamble). */
export const COVERAGE_WINDOW_MONTHS = 24;

/** A half-open [start, end) span in epoch milliseconds. */
export interface CoverageInterval {
  start: number;
  end: number;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * §E: build a `[start, end)` interval. `end` null/absent means "still current",
 * which anchors at the application date. Zero-length and inverted spans are
 * dropped (they cover nothing).
 */
export function coverageInterval(
  startIso: unknown,
  endIso: unknown,
  applicationMs: number,
): CoverageInterval | null {
  const start = parseIso(startIso);
  if (start === null) return null;
  const parsedEnd = parseIso(endIso);
  const end = parsedEnd === null ? applicationMs : parsedEnd;
  if (end <= start) return null;
  return { start, end };
}

/** Application date minus `months` whole calendar months, in epoch ms (UTC). */
export function monthsBefore(applicationMs: number, months: number): number {
  const d = new Date(applicationMs);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() - months,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/**
 * §E `24-month coverage`: the UNION of the supplied intervals, clipped to the
 * trailing 24-month window ending at the application date, must cover EVERY
 * month of that window with no gap. Overlapping intervals count once — summing
 * durations is NOT coverage (VR-132, VR-133).
 *
 * Returns true when the window is fully covered.
 */
export function coversTrailingWindow(
  intervals: readonly CoverageInterval[],
  applicationDate: string | Date,
  windowMonths: number = COVERAGE_WINDOW_MONTHS,
): boolean {
  const applicationMs =
    typeof applicationDate === "string" ? new Date(applicationDate).getTime() : applicationDate.getTime();
  if (Number.isNaN(applicationMs)) return false;
  const windowStart = monthsBefore(applicationMs, windowMonths);
  if (windowStart >= applicationMs) return true; // degenerate window covers itself

  // Clip to the window, drop what falls outside it, then sweep in start order.
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, windowStart), end: Math.min(i.end, applicationMs) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);

  let reached = windowStart;
  for (const span of clipped) {
    if (span.start > reached) return false; // gap before this span
    if (span.end > reached) reached = span.end;
    if (reached >= applicationMs) return true;
  }
  return reached >= applicationMs;
}

function addressComplete(a: Rec | null | undefined): boolean {
  if (!a) return false;
  return present(a.street) && present(a.city) && present(a.state) && present(a.zip);
}

// The 15 declaration answers (§4.2.4 Step 8), contracts.json Declarations field names.
const DECLARATION_KEYS: readonly { key: string; label: string }[] = [
  { key: "aOccupyPrimary", label: "A" },
  { key: "a1PriorOwnership", label: "A.1" },
  { key: "bSellerRelationship", label: "B" },
  { key: "cUndisclosedBorrowing", label: "C" },
  { key: "d1OtherMortgageApplication", label: "D.1" },
  { key: "d2NewCreditApplication", label: "D.2" },
  { key: "ePriorityLien", label: "E" },
  { key: "fCosignerUndisclosed", label: "F" },
  { key: "gOutstandingJudgments", label: "G" },
  { key: "hFederalDebtDelinquent", label: "H" },
  { key: "iPartyToLawsuit", label: "I" },
  { key: "jConveyedTitleInLieu", label: "J" },
  { key: "kPreForeclosureSale", label: "K" },
  { key: "lForeclosed", label: "L" },
  { key: "mBankruptcy", label: "M" },
];

// ---------------------------------------------------------------------------
// Per-step validators — each returns the step's issues
// ---------------------------------------------------------------------------

function issue(
  section: WizardSection,
  fieldPath: string,
  message: string,
  severity: IssueSeverity = "error",
  borrowerOrdinal?: number,
): ValidationIssue {
  const out: ValidationIssue = { section, fieldPath, severity, message };
  if (borrowerOrdinal !== undefined) out.borrowerOrdinal = borrowerOrdinal;
  return out;
}

function validateIdentity(
  b: BorrowerValidationInput,
  input: ApplicationValidationInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const o = b.ordinal;
  const at = (f: string, m: string) => issues.push(issue("identity", f, m, "error", o));

  if (!present(b.firstName)) at("firstName", "First name is required");
  if (!present(b.lastName)) at("lastName", "Last name is required");
  if (!b.hasSsn) at("ssn", "Social Security Number is required");
  if (!present(b.dateOfBirth)) {
    at("dateOfBirth", "Date of birth is required");
  } else {
    const age = ageAt(b.dateOfBirth as string, input.applicationDate);
    if (age === null || age < 18) {
      at("dateOfBirth", "Borrower must be at least 18 years old at the application date");
    }
  }
  if (!present(b.citizenship)) at("citizenship", "Citizenship is required");
  if (!present(b.maritalStatus)) at("maritalStatus", "Marital status is required");
  // §E preamble: at least one phone.
  if (!present(b.homePhone) && !present(b.cellPhone) && !present(b.workPhone)) {
    at("homePhone", "At least one phone number is required");
  }
  if (!present(b.email)) at("email", "Email is required");
  if (!present(b.creditType)) {
    at("creditType", "Type of credit is required");
  } else if (input.borrowers.length > 1 && b.creditType !== "joint") {
    // §4.2.4: "Joint required when co-borrower present".
    at("creditType", "Type of credit must be Joint when a co-borrower is present");
  }
  // Military service is req. (the served answer); conditionals per §4.2.4.
  const ms = b.militaryService;
  if (!ms || typeof ms.served !== "boolean") {
    at("militaryService.served", "Military service answer is required");
  } else if (ms.served === true) {
    if (!present(ms.status)) {
      at("militaryService.status", "Military service status is required");
    } else if (ms.status === "currently-serving" && !present(ms.projectedExpirationDate)) {
      at(
        "militaryService.projectedExpirationDate",
        "Projected expiration date is required while currently serving",
      );
    }
  }
  return issues;
}

function validateAddressHistory(
  b: BorrowerValidationInput,
  input: ApplicationValidationInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const o = b.ordinal;
  const at = (f: string, m: string) => issues.push(issue("address-history", f, m, "error", o));

  if (!addressComplete(b.currentAddress)) {
    at("currentAddress", "Current address (street, city, state, ZIP) is required");
  }
  if (!present(b.housingStatus)) at("housingStatus", "Housing status is required");
  // §E preamble: monthly rent iff renting.
  if (b.housingStatus === "rent" && num(b.monthlyRent) === null) {
    at("monthlyRent", "Monthly rent is required when renting");
  }
  if (num(b.yearsAtAddress) === null) at("yearsAtAddress", "Years at address is required");
  if (num(b.monthsAtAddress) === null) at("monthsAtAddress", "Months at address is required");

  // §E preamble / VR-132 (as amended by CH-016): 24-month address coverage is
  // the gap-free UNION of the current and previous address intervals measured
  // back from the application date — NEVER the sum of their durations. The
  // current address is ANCHORED at the application date and spans back
  // yearsAtAddress/monthsAtAddress; previous addresses supply
  // [fromDate, toDate) intervals. Overlapping intervals count once.
  //
  // There is NO duration-sum fallback. A previous-address row that omits
  // fromDate or toDate is UNDATABLE: it contributes no coverage, and its
  // presence fails the check with a field error naming the missing dates.
  // fromDate/toDate stay optional on the wire so drafts keep saving — the
  // requirement lands here, at the submission gate, exactly as VR-133 puts the
  // employment requirement at the gate rather than in the wire schema.
  const currentMonths = (num(b.yearsAtAddress) ?? 0) * 12 + (num(b.monthsAtAddress) ?? 0);
  const previousAddresses = arr(b.previousAddresses);
  const applicationMs =
    typeof input.applicationDate === "string"
      ? new Date(input.applicationDate).getTime()
      : input.applicationDate.getTime();

  const intervals: CoverageInterval[] = [];
  if (Number.isFinite(applicationMs) && currentMonths > 0) {
    intervals.push({ start: monthsBefore(applicationMs, currentMonths), end: applicationMs });
  }
  let hasUndatableRow = false;
  for (const [i, prev] of previousAddresses.entries()) {
    const hasFrom = typeof prev.fromDate === "string" && prev.fromDate.trim() !== "";
    const hasTo = typeof prev.toDate === "string" && prev.toDate.trim() !== "";
    if (!hasFrom) {
      hasUndatableRow = true;
      at(
        `previousAddresses[${i}].fromDate`,
        `Previous address ${i + 1} is missing its move-in date — the 24-month history cannot be checked for gaps without it`,
      );
    }
    if (!hasTo) {
      hasUndatableRow = true;
      at(
        `previousAddresses[${i}].toDate`,
        `Previous address ${i + 1} is missing its move-out date — the 24-month history cannot be checked for gaps without it`,
      );
    }
    // An undatable row covers nothing; only fully dated rows join the union.
    if (!hasFrom || !hasTo) continue;
    const span = coverageInterval(prev.fromDate, prev.toDate, applicationMs);
    if (span) intervals.push(span);
  }
  // The missing-date errors above are themselves the coverage failure for an
  // undatable history — don't stack the generic gap message on top of them.
  if (!hasUndatableRow && !coversTrailingWindow(intervals, input.applicationDate)) {
    at(
      "previousAddresses",
      "Address history must cover the full 24 months before the application date with no gaps — add previous addresses",
    );
  }
  return issues;
}

function validateEmploymentIncome(
  b: BorrowerValidationInput,
  input: ApplicationValidationInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const o = b.ordinal;
  const at = (f: string, m: string) => issues.push(issue("employment-income", f, m, "error", o));

  if (!present(b.employmentType)) {
    at("employmentType", "Employment type is required");
    return issues;
  }
  const employed = b.employmentType === "employed" || b.employmentType === "self-employed";
  const employments = arr(b.employments);
  if (employed) {
    // §4.2.4: at least one current employment, or "Not employed" declared.
    if (employments.length === 0) {
      at("employments", "At least one current employment is required");
    }
    for (const [i, emp] of employments.entries()) {
      if (!present(emp.employerName)) {
        at(`employments[${i}].employerName`, "Employer name is required");
      }
      if (emp.selfEmployed === true) {
        // §4.2.4: self-employed monthly income (or loss) req. if self-employed.
        if (num(emp.selfEmployedMonthlyIncome) === null) {
          at(
            `employments[${i}].selfEmployedMonthlyIncome`,
            "Self-employed monthly income (or loss) is required",
          );
        }
      } else if (num(emp.baseMonthlyIncome) === null) {
        // §4.2.4: base monthly income req. when employed.
        at(`employments[${i}].baseMonthlyIncome`, "Base monthly income is required");
      }
    }
    // §E preamble / VR-133: 24-month employment coverage is the gap-free UNION
    // of the intervals measured back from the application date — NEVER the sum
    // of their durations. Current employments span startDate → application
    // date; previous employments span startDate → endDate. Two concurrent jobs
    // count once, and a hole anywhere in the trailing 24 months fails.
    const applicationMs =
      typeof input.applicationDate === "string"
        ? new Date(input.applicationDate).getTime()
        : input.applicationDate.getTime();
    const intervals: CoverageInterval[] = [];
    for (const emp of employments) {
      const span = coverageInterval(emp.startDate, null, applicationMs);
      if (span) intervals.push(span);
    }
    for (const prev of arr(b.previousEmployments)) {
      const span = coverageInterval(prev.startDate, prev.endDate, applicationMs);
      if (span) intervals.push(span);
    }
    if (!coversTrailingWindow(intervals, input.applicationDate)) {
      at(
        "previousEmployments",
        "Employment history must cover the full 24 months before the application date with no gaps — add previous employment",
      );
    }
  }
  return issues;
}

function validateAssetsReo(input: ApplicationValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const data = input.data;
  // §E preamble: at least one asset.
  if (arr(data?.assets).length === 0) {
    issues.push(issue("assets-reo", "assets", "At least one asset is required"));
  }
  // §E preamble: REO required iff declaration A.1 yes (any borrower) or occupancy
  // is not primary residence.
  const a1Yes = input.borrowers.some((b) => b.declarations?.a1PriorOwnership === true);
  const occupancy = data?.subjectProperty?.occupancy;
  const nonPrimary = present(occupancy) && occupancy !== "primary-residence";
  if ((a1Yes || nonPrimary) && arr(data?.realEstateOwned).length === 0) {
    issues.push(
      issue(
        "assets-reo",
        "realEstateOwned",
        a1Yes
          ? "Real estate owned is required when declaration A.1 is answered Yes"
          : "Real estate owned is required when occupancy is not primary residence",
      ),
    );
  }
  return issues;
}

// Step 5 (liabilities) has no required fields (§4.2.4: "optional but recommended").
function validateLiabilities(): ValidationIssue[] {
  return [];
}

function validateSubjectProperty(input: ApplicationValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sp = input.data?.subjectProperty ?? null;
  const loan = input.data?.loan ?? null;
  const at = (f: string, m: string) => issues.push(issue("subject-property", f, m));

  if (!addressComplete((sp?.address ?? null) as Rec | null)) {
    at("address", "Property address (street, city, state, ZIP) is required");
  }
  const units = num(sp?.numberOfUnits);
  if (units === null) at("numberOfUnits", "Number of units is required");
  if (!present(sp?.propertyType)) at("propertyType", "Property type is required");
  if (!present(sp?.occupancy)) at("occupancy", "Occupancy is required");
  if (typeof sp?.mixedUse !== "boolean") at("mixedUse", "Mixed-use answer is required");
  if (typeof sp?.manufacturedHome !== "boolean") {
    at("manufacturedHome", "Manufactured-home answer is required");
  }
  if (num(sp?.estimatedValue) === null) {
    at("estimatedValue", "Estimated property value / purchase price is required");
  }
  if (!present(sp?.titleNames)) at("titleNames", "Title names are required");
  if (!present(sp?.titleManner)) at("titleManner", "Manner of holding title is required");
  if (!present(sp?.estate)) {
    at("estate", "Estate is required");
  } else if (sp?.estate === "leasehold" && !present(sp?.leaseholdExpirationDate)) {
    // §E preamble: leasehold expiration iff leasehold.
    at("leaseholdExpirationDate", "Leasehold expiration date is required for a leasehold estate");
  }
  // §E preamble: purchase fields iff purchase — target closing date lives in Step 6.
  if (loan?.loanPurpose === "purchase" && !present(sp?.targetClosingDate)) {
    at("targetClosingDate", "Target closing date is required for a purchase");
  }
  return issues;
}

function validateLoanDetails(input: ApplicationValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const loan = input.data?.loan ?? null;
  const phe = input.data?.proposedHousingExpense ?? null;
  const at = (f: string, m: string) => issues.push(issue("loan-details", f, m));

  if (!present(loan?.loanPurpose)) at("loanPurpose", "Loan purpose is required");
  if (!present(loan?.loanType)) at("loanType", "Loan type is required");
  if (!present(loan?.amortizationType)) {
    at("amortizationType", "Amortization type is required");
  } else if (loan?.amortizationType === "adjustable") {
    // §E preamble: ARM periods iff adjustable.
    if (num(loan?.armInitialFixedMonths) === null) {
      at("armInitialFixedMonths", "Initial fixed period is required for an adjustable loan");
    }
    if (num(loan?.armAdjustmentMonths) === null) {
      at("armAdjustmentMonths", "Adjustment period is required for an adjustable loan");
    }
  }
  if (num(loan?.loanTermMonths) === null) at("loanTermMonths", "Loan term is required");
  if (num(loan?.requestedLoanAmount) === null) {
    at("requestedLoanAmount", "Requested loan amount is required");
  }
  // §E preamble: purchase fields iff purchase.
  if (loan?.loanPurpose === "purchase") {
    if (num(loan?.downPaymentAmount) === null) {
      at("downPaymentAmount", "Down payment amount is required for a purchase");
    }
    if (!present(loan?.downPaymentSource)) {
      at("downPaymentSource", "Down payment source is required for a purchase");
    }
  }
  // §E preamble: refinance details iff refinance purpose.
  if (loan?.loanPurpose === "refinance-rate-term" || loan?.loanPurpose === "refinance-cash-out") {
    const refi = (loan?.refinance ?? null) as Rec | null;
    if (!refi) {
      at("refinance", "Refinance details are required for a refinance");
    } else {
      if (num(refi.originalCost) === null) {
        at("refinance.originalCost", "Original cost is required for a refinance");
      }
      if (num(refi.existingLiens) === null) {
        at("refinance.existingLiens", "Existing liens amount is required for a refinance");
      }
      if (!present(refi.purposeOfRefinance)) {
        at("refinance.purposeOfRefinance", "Purpose of refinance is required");
      }
    }
  }
  // §4.2.4 Step 7: proposed housing expense — insurance and taxes req.
  // (ProposedHousingExpense has no §B wizard write path — see task-011 report — but
  // the requirement stands; corrections/seeded data can populate it.)
  if (num(phe?.homeownersInsurance) === null) {
    at("proposedHousingExpense.homeownersInsurance", "Homeowner's insurance is required");
  }
  if (num(phe?.propertyTaxes) === null) {
    at("proposedHousingExpense.propertyTaxes", "Property taxes are required");
  }
  // LTV gate (REQ-036 / §4.2.7): block is an error, warn is a warning.
  if (input.ltv !== null && input.ltv > input.ltvSubmissionBlockPercent) {
    at(
      "ltv",
      `LTV ${input.ltv}% exceeds the maximum ${input.ltvSubmissionBlockPercent}% — submission is blocked`,
    );
  } else if (input.ltv !== null && input.ltv > input.ltvWarningPercent) {
    issues.push(
      issue(
        "loan-details",
        "ltv",
        `LTV ${input.ltv}% exceeds ${input.ltvWarningPercent}% — review your loan amount and property value`,
        "warning",
      ),
    );
  }
  return issues;
}

function validateDeclarations(b: BorrowerValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const o = b.ordinal;
  const d = b.declarations ?? null;
  const at = (f: string, m: string) => issues.push(issue("declarations", f, m, "error", o));

  for (const { key, label } of DECLARATION_KEYS) {
    if (!d || typeof d[key] !== "boolean") {
      at(key, `Declaration ${label} must be answered`);
    }
  }
  if (d) {
    // Conditional details (§4.2.4 Step 8).
    if (d.a1PriorOwnership === true) {
      if (!present(d.a1PropertyType)) {
        at("a1PropertyType", "Property type is required when declaration A.1 is Yes");
      }
      if (!present(d.a1TitleHeld)) {
        at("a1TitleHeld", "How title was held is required when declaration A.1 is Yes");
      }
    }
    if (d.cUndisclosedBorrowing === true && num(d.cAmount) === null) {
      at("cAmount", "Amount is required when declaration C is Yes");
    }
    if (d.mBankruptcy === true && !present(d.mBankruptcyType)) {
      at("mBankruptcyType", "Bankruptcy type is required when declaration M is Yes");
    }
  }
  return issues;
}

// Step 9 (demographics) — every item optional ("I do not wish to provide").
function validateDemographics(): ValidationIssue[] {
  return [];
}

// ---------------------------------------------------------------------------
// Presence detection (step statuses: not-started vs in-progress)
// ---------------------------------------------------------------------------

function borrowerSectionTouched(b: BorrowerValidationInput, section: WizardSection): boolean {
  switch (section) {
    case "identity":
      return (
        present(b.firstName) ||
        present(b.lastName) ||
        b.hasSsn ||
        present(b.dateOfBirth) ||
        present(b.citizenship) ||
        present(b.maritalStatus) ||
        present(b.email) ||
        present(b.creditType) ||
        b.militaryService != null
      );
    case "address-history":
      return (
        b.currentAddress != null ||
        present(b.housingStatus) ||
        num(b.yearsAtAddress) !== null ||
        arr(b.previousAddresses).length > 0
      );
    case "employment-income":
      return (
        present(b.employmentType) ||
        arr(b.employments).length > 0 ||
        arr(b.previousEmployments).length > 0 ||
        arr(b.otherIncome).length > 0
      );
    case "declarations":
      return b.declarations != null && Object.keys(b.declarations).length > 0;
    case "demographics":
      return b.demographics != null && Object.keys(b.demographics).length > 0;
    default:
      return false;
  }
}

function stepTouched(step: number, input: ApplicationValidationInput): boolean {
  const data = input.data;
  switch (step) {
    case 1:
    case 2:
    case 3:
    case 8:
    case 9: {
      const section = STEP_SECTIONS[step] as WizardSection;
      return input.borrowers.some((b) => borrowerSectionTouched(b, section));
    }
    case 4:
      return (
        arr(data?.assets).length > 0 ||
        arr(data?.otherCredits).length > 0 ||
        arr(data?.realEstateOwned).length > 0
      );
    case 5:
      return arr(data?.liabilities).length > 0 || arr(data?.otherLiabilities).length > 0;
    case 6:
      return data?.subjectProperty != null;
    case 7:
      return data?.loan != null;
    case 10:
      return input.signedOrdinals.length > 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Engine entry points
// ---------------------------------------------------------------------------

/** All validation issues across steps 1-9 (errors + warnings). */
export function collectValidationIssues(input: ApplicationValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const b of input.borrowers) {
    issues.push(...validateIdentity(b, input));
    issues.push(...validateAddressHistory(b, input));
    issues.push(...validateEmploymentIncome(b, input));
    issues.push(...validateDeclarations(b));
  }
  issues.push(...validateAssetsReo(input));
  issues.push(...validateLiabilities());
  issues.push(...validateSubjectProperty(input));
  issues.push(...validateLoanDetails(input));
  issues.push(...validateDemographics());
  return issues;
}

/** Issues belonging to one section (optionally one borrower) — SectionSaveResponse.issues. */
export function issuesForSection(
  input: ApplicationValidationInput,
  section: WizardSection,
  borrowerOrdinal?: number,
): ValidationIssue[] {
  return collectValidationIssues(input).filter(
    (i) =>
      i.section === section &&
      (borrowerOrdinal === undefined ||
        i.borrowerOrdinal === undefined ||
        i.borrowerOrdinal === borrowerOrdinal),
  );
}

/**
 * The §A ValidationSummary: issues + per-step statuses + completion percent.
 * A step is complete when it is error-free and touched (steps without required
 * fields count as complete once touched; step 10 requires every borrower to
 * hold a currently-valid signature).
 */
export function buildValidationSummary(input: ApplicationValidationInput): ValidationSummary {
  const issues = collectValidationIssues(input);

  const stepStatuses: StepStatus[] = [];
  let completeCount = 0;
  for (let step = 1; step <= 10; step += 1) {
    const section = STEP_SECTIONS[step];
    const stepErrors =
      section === null
        ? []
        : issues.filter((i) => i.section === section && i.severity === "error");
    const touched = stepTouched(step, input);

    let status: StepCompletion;
    if (step === 10) {
      const allSigned =
        input.borrowers.length > 0 &&
        input.borrowers.every((b) => input.signedOrdinals.includes(b.ordinal));
      status = allSigned ? "complete" : touched ? "in-progress" : "not-started";
    } else if (stepErrors.length === 0) {
      // Error-free steps (including steps with no required fields, e.g. 5 and 9)
      // still read not-started until data appears.
      status = touched ? "complete" : "not-started";
    } else {
      status = touched ? "in-progress" : "not-started";
    }
    if (status === "complete") completeCount += 1;
    stepStatuses.push({ step, status });
  }

  return {
    issues,
    completionPct: Math.round((completeCount / 10) * 100),
    stepStatuses,
  };
}

export interface SubmissionValidationResult {
  ok: boolean;
  /** Severity=error issues that block T1/T36 (required fields, age, LTV block). */
  errors: ValidationIssue[];
}

/**
 * The T1/T36 submission gate (task-019 calls this via the submission service):
 * every severity=error issue blocks submission. Signature completeness (INV-029)
 * is checked by the caller against live Signature rows; `signedOrdinals` here
 * only feeds step-10 status.
 */
export function validateForSubmission(
  input: ApplicationValidationInput,
): SubmissionValidationResult {
  const errors = collectValidationIssues(input).filter((i) => i.severity === "error");
  return { ok: errors.length === 0, errors };
}
