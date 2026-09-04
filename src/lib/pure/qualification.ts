// Shared DTI / LTV / CLTV / qualifying-score module — PURE CORE (task-010,
// REQ-036, NFR-008, SEC-7, AC-13).
//
// This file is the SINGLE implementation of the contracts.md §E
// "Algorithmic precision" formulas. It is deliberately pure:
//   - NO Prisma, NO fetch, NO Date.now, NO randomness, NO side effects.
//   - Deterministic: identical input values -> byte-identical output values,
//     which is what makes AC-13 ("identical results for identical data" across
//     wizard badge, corrections, underwriting panel, AUS, analytics bands,
//     HMDA LAR) provable.
// DB-aware callers go through src/lib/services/qualification.ts, which maps
// live rows + live SystemConfig thresholds onto these functions.
//
// Input shapes mirror the contracts.json models with VERBATIM field names
// (EmploymentRecord, OtherIncomeRecord, RealEstateOwnedRecord, LiabilityRecord,
// OtherLiabilityRecord, ProposedHousingExpense, SubjectProperty, LoanDetails,
// OtherNewMortgage, AvmCheckResult, BureauScore). Only the fields the §E
// formulas read are declared; extra fields on passed objects are ignored.
//
// MONEY / PRECISION / ROUNDING (documented decision):
//   - Currency inputs are contracts.md §A "number in dollars with cents"
//     (e.g. 1234.56). Every currency amount is converted to INTEGER CENTS
//     (Math.round(dollars * 100)) before summation, so sums are exact integer
//     arithmetic with no floating-point drift; sub-cent inputs round to the
//     nearest cent.
//   - Ratios are expressed as PERCENT values (DTI 43 == 43%), matching the §E
//     threshold statements ("Warning > 80%, block > 97%", SystemConfig percent
//     keys) and the Application.dti/ltv/cltv Decimal(8,4) columns.
//   - AMBIGUITY (named per task instructions): contracts §E declares no
//     explicit precision/rounding rule for the ratios. Decision: percent
//     values are rounded HALF-AWAY-FROM-ZERO to 3 DECIMAL PLACES here, at the
//     single shared boundary, so every consumer receives the same rounded
//     value (AC-13). 3 dp fits the Decimal(8,4) columns.
//
// INV-025: currency fields reject negative values everywhere EXCEPT
// EmploymentRecord.selfEmployedMonthlyIncome (a self-employment loss is
// permitted and reduces total income). Violations throw CurrencyValidationError.

// ---------------------------------------------------------------------------
// Input shapes (contracts.json field names, verbatim)
// ---------------------------------------------------------------------------

/** contracts.json EmploymentRecord — the seven §E income components. */
export interface EmploymentIncomeInput {
  /** EmploymentRecord.baseMonthlyIncome */
  baseMonthlyIncome?: number | null;
  /** EmploymentRecord.overtime */
  overtime?: number | null;
  /** EmploymentRecord.bonus */
  bonus?: number | null;
  /** EmploymentRecord.commission */
  commission?: number | null;
  /** EmploymentRecord.militaryEntitlements */
  militaryEntitlements?: number | null;
  /** EmploymentRecord.otherMonthlyIncome */
  otherMonthlyIncome?: number | null;
  /** EmploymentRecord.selfEmployedMonthlyIncome — MAY be negative (loss, INV-025). */
  selfEmployedMonthlyIncome?: number | null;
}

/** contracts.json OtherIncomeRecord (Step-3 "income from other sources"). */
export interface OtherIncomeInput {
  /** OtherIncomeRecord.source — OtherIncomeSource enum value (e.g. "rental"). */
  source?: string | null;
  /** OtherIncomeRecord.monthlyAmount */
  monthlyAmount?: number | null;
}

/** Per-borrower income rows (Borrower.employments / Borrower.otherIncome). */
export interface BorrowerIncomeInput {
  employments?: readonly EmploymentIncomeInput[] | null;
  otherIncome?: readonly OtherIncomeInput[] | null;
}

/** contracts.json RealEstateOwnedRecord — only the §E income field. */
export interface ReoIncomeInput {
  /** RealEstateOwnedRecord.netMonthlyRentalIncome (ASM-002: counts as income). */
  netMonthlyRentalIncome?: number | null;
}

/** contracts.json SubjectProperty — fields task-010 reads. */
export interface SubjectPropertyInput {
  /** SubjectProperty.estimatedValue — the stated value (LTV denominator input). */
  estimatedValue?: number | null;
  /**
   * SubjectProperty.expectedMonthlyRentalIncome — present in the shape but
   * EXCLUDED from the DTI income enumeration (§E, ASM-002). computeDti never
   * reads it; it is declared here only to document the exclusion.
   */
  expectedMonthlyRentalIncome?: number | null;
}

/** contracts.json LiabilityRecord — the §E debt-service fields. */
export interface LiabilityInput {
  /** LiabilityRecord.monthlyPayment */
  monthlyPayment?: number | null;
  /** LiabilityRecord.paidOffAtClosing — true rows are EXCLUDED from DTI (§E). */
  paidOffAtClosing?: boolean | null;
}

/** contracts.json OtherLiabilityRecord. */
export interface OtherLiabilityInput {
  /** OtherLiabilityRecord.monthlyPayment */
  monthlyPayment?: number | null;
}

/** contracts.json ProposedHousingExpense — ALL eight components (§E "total"). */
export interface ProposedHousingExpenseInput {
  firstMortgagePi?: number | null;
  subordinateLiens?: number | null;
  homeownersInsurance?: number | null;
  supplementalInsurance?: number | null;
  propertyTaxes?: number | null;
  mortgageInsurance?: number | null;
  hoaDues?: number | null;
  other?: number | null;
}

/** contracts.json OtherNewMortgage — the CLTV subordinate-lien source. */
export interface OtherNewMortgageInput {
  /** OtherNewMortgage.lienType — LienType enum: "first-lien" | "subordinate-lien". */
  lienType?: string | null;
  /** OtherNewMortgage.amount — the lien amount added to the CLTV numerator. */
  amount?: number | null;
}

/**
 * AVM availability input (ASM-006). AvmCheckResult itself carries the value
 * (`estimatedValue`); the staleness fields live on the surrounding
 * UnderwritingResultInfo (`status`, `isStale`) — both are mirrored here so the
 * availability rule is a pure predicate on plain data.
 */
export interface AvmAvailabilityInput {
  /** AvmCheckResult.estimatedValue */
  estimatedValue?: number | null;
  /** UnderwritingResultInfo.status — CheckStatus: "running" | "completed" | "error". */
  status?: string | null;
  /** UnderwritingResultInfo.isStale — stale results are NOT available (ASM-006). */
  isStale?: boolean | null;
}

/** contracts.json BureauScore. */
export interface BureauScoreInput {
  /** BureauScore.bureau */
  bureau?: string | null;
  /** BureauScore.score */
  score?: number | null;
  /** BureauScore.unavailable — true = this bureau returned no score. */
  unavailable?: boolean | null;
}

// ---------------------------------------------------------------------------
// Composite inputs
// ---------------------------------------------------------------------------

/** Everything the §E DTI formula reads. */
export interface DtiInput {
  /** All borrowers on the file (primary + co-borrower) — §E "Σ over all borrowers". */
  borrowers: readonly BorrowerIncomeInput[];
  /** ApplicationData.realEstateOwned — §E "Σ REO netMonthlyRentalIncome". */
  realEstateOwned?: readonly ReoIncomeInput[] | null;
  /** ApplicationData.liabilities — §E "Σ liability monthlyPayment where paidOffAtClosing=false". */
  liabilities?: readonly LiabilityInput[] | null;
  /** ApplicationData.otherLiabilities — §E "Σ otherLiabilities monthlyPayment". */
  otherLiabilities?: readonly OtherLiabilityInput[] | null;
  /** ApplicationData.proposedHousingExpense — §E "total proposed monthly housing expense". */
  proposedHousingExpense?: ProposedHousingExpenseInput | null;
  /**
   * ApplicationData.subjectProperty — accepted so callers can pass the whole
   * picture, but its expectedMonthlyRentalIncome is EXCLUDED from income
   * (§E, ASM-002). Never read by computeDti.
   */
  subjectProperty?: SubjectPropertyInput | null;
}

/** Everything the §E LTV formula reads. */
export interface LtvInput {
  /** LoanDetails.requestedLoanAmount — the LTV numerator. */
  requestedLoanAmount?: number | null;
  /** SubjectProperty.estimatedValue — the stated value. */
  estimatedValue?: number | null;
  /** Latest AVM result, if any (ASM-006 availability applies). */
  avm?: AvmAvailabilityInput | null;
}

/** Everything the §E CLTV formula reads (LTV input + subordinate liens). */
export interface CltvInput extends LtvInput {
  /** LoanDetails.otherNewMortgages — subordinate-lien amounts join the numerator. */
  otherNewMortgages?: readonly OtherNewMortgageInput[] | null;
}

/** The composed input for computeQualification. */
export interface QualificationInput extends DtiInput, CltvInput {}

/** Thresholds — ALWAYS passed in by the caller (SystemConfig-sourced, never hardcoded here). */
export interface QualificationThresholds {
  /** SystemConfig `dti.warningPercent` (§4.6.11 default 43). */
  dtiWarningPercent: number;
  /** SystemConfig `ltv.warningPercent` (§4.6.11 default 80). */
  ltvWarningPercent: number;
  /** SystemConfig `ltv.submissionBlockPercent` (§4.6.11 default 97). */
  ltvSubmissionBlockPercent: number;
}

/** Ratios (percent, 3 dp) + threshold evaluations. */
export interface QualificationResult {
  /** DTI percent, 3 dp; null when total monthly income is not positive. */
  dti: number | null;
  /** LTV percent, 3 dp; null when loan amount or a positive denominator is missing. */
  ltv: number | null;
  /** CLTV percent, 3 dp; null under the same conditions as ltv. */
  cltv: number | null;
  /** §E "Warning > 43%": dti !== null && dti > dtiWarningPercent. */
  dtiWarning: boolean;
  /** §E "Warning > 80%": ltv !== null && ltv > ltvWarningPercent. */
  ltvWarning: boolean;
  /**
   * §E "block > 97%": ltv !== null && ltv > ltvSubmissionBlockPercent.
   * AMBIGUITY (named): the SystemConfig registry description says "at or
   * above"; §E and the task-016 submit gate ("LTV ≤ 97%" allowed) say strictly
   * greater. §E is the algorithmic authority — strict `>` implemented.
   */
  ltvSubmissionBlocked: boolean;
}

// ---------------------------------------------------------------------------
// INV-025 currency validation
// ---------------------------------------------------------------------------

/** Thrown when a currency field violates INV-025 (negative, or not a finite number). */
export class CurrencyValidationError extends Error {
  readonly fieldPath: string;
  constructor(fieldPath: string, message: string) {
    super(`${fieldPath}: ${message}`);
    this.name = "CurrencyValidationError";
    this.fieldPath = fieldPath;
  }
}

/**
 * Convert a currency amount (dollars with cents) to integer cents.
 * - undefined / null -> 0 cents (absent optional currency fields contribute nothing).
 * - non-finite numbers -> CurrencyValidationError.
 * - negative -> CurrencyValidationError UNLESS allowNegative (INV-025: only
 *   selfEmployedMonthlyIncome may be negative — a permitted loss).
 */
function toCents(value: number | null | undefined, fieldPath: string, allowNegative = false): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CurrencyValidationError(fieldPath, "currency value must be a finite number");
  }
  if (value < 0 && !allowNegative) {
    throw new CurrencyValidationError(
      fieldPath,
      "negative currency values are rejected (INV-025; only selfEmployedMonthlyIncome may be negative)",
    );
  }
  return Math.round(value * 100);
}

/**
 * Round a percent value HALF-AWAY-FROM-ZERO to 3 decimal places — the module's
 * single documented rounding boundary (see header). Exported so consumers that
 * must re-round derived displays match exactly.
 */
export function roundRatioPercent(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 1000)) / 1000;
}

// ---------------------------------------------------------------------------
// DTI — contracts.md §E (task-010, SEC-7):
//   DTI = (Σ liability monthlyPayment where paidOffAtClosing=false
//          + Σ otherLiabilities monthlyPayment
//          + total proposed monthly housing expense)
//       ÷ (Σ over all borrowers of: baseMonthlyIncome + overtime + bonus
//          + commission + militaryEntitlements + otherMonthlyIncome
//          + selfEmployedMonthlyIncome + Σ otherIncome.monthlyAmount
//          + Σ REO netMonthlyRentalIncome)
//   Subject-property expectedMonthlyRentalIncome is EXCLUDED (ASM-002).
// ---------------------------------------------------------------------------

/** §E numerator: total monthly debt service, in integer cents. */
export function monthlyDebtServiceCents(input: DtiInput): number {
  let cents = 0;

  // §E: "Σ liability monthlyPayment where paidOffAtClosing=false" — a row
  // marked paidOffAtClosing=true is excluded from debt service.
  for (const [i, liability] of (input.liabilities ?? []).entries()) {
    if (liability.paidOffAtClosing === true) continue;
    cents += toCents(liability.monthlyPayment, `liabilities[${i}].monthlyPayment`);
  }

  // §E: "+ Σ otherLiabilities monthlyPayment" (alimony, child support, ... —
  // OtherLiabilityType rows carry a monthly payment unconditionally).
  for (const [i, other] of (input.otherLiabilities ?? []).entries()) {
    cents += toCents(other.monthlyPayment, `otherLiabilities[${i}].monthlyPayment`);
  }

  // §E: "+ total proposed monthly housing expense" — the sum of ALL eight
  // ProposedHousingExpense components (contracts.json shape, verbatim).
  const phe = input.proposedHousingExpense;
  if (phe) {
    cents += toCents(phe.firstMortgagePi, "proposedHousingExpense.firstMortgagePi");
    cents += toCents(phe.subordinateLiens, "proposedHousingExpense.subordinateLiens");
    cents += toCents(phe.homeownersInsurance, "proposedHousingExpense.homeownersInsurance");
    cents += toCents(phe.supplementalInsurance, "proposedHousingExpense.supplementalInsurance");
    cents += toCents(phe.propertyTaxes, "proposedHousingExpense.propertyTaxes");
    cents += toCents(phe.mortgageInsurance, "proposedHousingExpense.mortgageInsurance");
    cents += toCents(phe.hoaDues, "proposedHousingExpense.hoaDues");
    cents += toCents(phe.other, "proposedHousingExpense.other");
  }

  return cents;
}

/** §E denominator: total monthly income, in integer cents (may be ≤ 0 via self-employment loss). */
export function monthlyIncomeCents(input: DtiInput): number {
  let cents = 0;

  // §E: "Σ over all borrowers of: baseMonthlyIncome + overtime + bonus +
  // commission + militaryEntitlements + otherMonthlyIncome +
  // selfEmployedMonthlyIncome + Σ otherIncome.monthlyAmount"
  for (const [b, borrower] of input.borrowers.entries()) {
    for (const [e, emp] of (borrower.employments ?? []).entries()) {
      const at = `borrowers[${b}].employments[${e}]`;
      cents += toCents(emp.baseMonthlyIncome, `${at}.baseMonthlyIncome`);
      cents += toCents(emp.overtime, `${at}.overtime`);
      cents += toCents(emp.bonus, `${at}.bonus`);
      cents += toCents(emp.commission, `${at}.commission`);
      cents += toCents(emp.militaryEntitlements, `${at}.militaryEntitlements`);
      cents += toCents(emp.otherMonthlyIncome, `${at}.otherMonthlyIncome`);
      // INV-025: the ONE currency field where negative is permitted (loss).
      cents += toCents(emp.selfEmployedMonthlyIncome, `${at}.selfEmployedMonthlyIncome`, true);
    }
    // Step-3 other-income rows count for EVERY OtherIncomeSource, including
    // source="rental" (ASM-002: Step-3 `rental` rows are part of net rental income).
    for (const [o, row] of (borrower.otherIncome ?? []).entries()) {
      cents += toCents(row.monthlyAmount, `borrowers[${b}].otherIncome[${o}].monthlyAmount`);
    }
  }

  // §E: "+ Σ REO netMonthlyRentalIncome" (ASM-002). NOTE: the REO record's
  // gross monthlyRentalIncome and its mortgages' payments are NOT separately
  // enumerated by §E — netMonthlyRentalIncome is the single netted figure.
  for (const [i, reo] of (input.realEstateOwned ?? []).entries()) {
    cents += toCents(reo.netMonthlyRentalIncome, `realEstateOwned[${i}].netMonthlyRentalIncome`);
  }

  // §E / ASM-002: SubjectProperty.expectedMonthlyRentalIncome is EXCLUDED —
  // deliberately never read here even when input.subjectProperty is present.

  return cents;
}

/**
 * DTI percent (3 dp) per §E, or null when total monthly income is not
 * positive (a ratio over zero/negative income is undefined; callers surface
 * "no DTI" rather than a misleading number).
 */
export function computeDti(input: DtiInput): number | null {
  const incomeCents = monthlyIncomeCents(input);
  if (incomeCents <= 0) return null;
  const debtCents = monthlyDebtServiceCents(input);
  return roundRatioPercent((debtCents / incomeCents) * 100);
}

// ---------------------------------------------------------------------------
// LTV / CLTV — contracts.md §E:
//   LTV = requestedLoanAmount ÷ min(estimatedValue, avmValue-when-available)
//   A stale AVM result is NOT available (ASM-006).
//   CLTV = (requestedLoanAmount + Σ subordinate lien amounts) ÷ same denominator
// ---------------------------------------------------------------------------

/**
 * ASM-006 availability predicate: the AVM value participates in the LTV
 * denominator ONLY when a result exists, is completed, is NOT stale, and
 * carries a positive value. Stale => LTV reverts to the stated value until
 * the AVM is re-run ("re-run pending" on approval screens).
 */
export function avmValueWhenAvailable(avm: AvmAvailabilityInput | null | undefined): number | null {
  if (!avm) return null;
  if (avm.status !== "completed") return null; // running/error results carry no usable value
  if (avm.isStale === true) return null; // ASM-006: stale is NOT available
  const value = avm.estimatedValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** §E shared denominator: min(estimatedValue, avmValue-when-available), in cents; null when no positive stated value. */
function ltvDenominatorCents(input: LtvInput): number | null {
  const statedCents = toCents(input.estimatedValue, "subjectProperty.estimatedValue");
  if (statedCents <= 0) return null; // no stated value -> no ratio
  const avmValue = avmValueWhenAvailable(input.avm);
  if (avmValue === null) return statedCents;
  const avmCents = toCents(avmValue, "avm.estimatedValue");
  // §E: "min(estimatedValue, avmValue-when-available)"
  return Math.min(statedCents, avmCents);
}

/** LTV percent (3 dp) per §E, or null when loan amount or denominator is missing. */
export function computeLtv(input: LtvInput): number | null {
  const loanCents = toCents(input.requestedLoanAmount, "loan.requestedLoanAmount");
  if (loanCents <= 0) return null;
  const denomCents = ltvDenominatorCents(input);
  if (denomCents === null) return null;
  return roundRatioPercent((loanCents / denomCents) * 100);
}

/** §E CLTV numerator addition: "Σ subordinate lien amounts" (OtherNewMortgage rows with lienType="subordinate-lien"). */
export function subordinateLienAmountCents(
  otherNewMortgages: readonly OtherNewMortgageInput[] | null | undefined,
): number {
  let cents = 0;
  for (const [i, m] of (otherNewMortgages ?? []).entries()) {
    if (m.lienType !== "subordinate-lien") continue; // LienType enum value, verbatim
    cents += toCents(m.amount, `loan.otherNewMortgages[${i}].amount`);
  }
  return cents;
}

/** CLTV percent (3 dp) per §E: subordinate lien amounts join the numerator over the SAME denominator as LTV. */
export function computeCltv(input: CltvInput): number | null {
  const loanCents = toCents(input.requestedLoanAmount, "loan.requestedLoanAmount");
  if (loanCents <= 0) return null;
  const denomCents = ltvDenominatorCents(input);
  if (denomCents === null) return null;
  const numeratorCents = loanCents + subordinateLienAmountCents(input.otherNewMortgages);
  return roundRatioPercent((numeratorCents / denomCents) * 100);
}

// ---------------------------------------------------------------------------
// Qualifying credit score — contracts.md §E / ASM-003:
//   "Qualifying credit score = lower of the two borrowers' middle scores,
//    single function feeding pricing, AUS, qualification card, LAR."
// ---------------------------------------------------------------------------

/**
 * One borrower's middle score from their BureauScore rows (bureaus reporting
 * unavailable=true or without a score are ignored):
 *   - 3 available scores -> the middle (median) value;
 *   - 2 available scores -> the LOWER of the two (partial two-bureau pulls per
 *     the §6.3.1 simulation; AMBIGUITY (named): §E defines only "middle score"
 *     — for a two-score file the conservative industry rule, lower-of-two, is
 *     applied and documented here);
 *   - 1 available score  -> that score;
 *   - 0 available scores -> null.
 */
export function middleBureauScore(bureauScores: readonly BureauScoreInput[]): number | null {
  const available = bureauScores
    .filter((s) => s.unavailable !== true && typeof s.score === "number" && Number.isFinite(s.score))
    .map((s) => s.score as number)
    .sort((a, b) => a - b);
  if (available.length === 0) return null;
  if (available.length === 1) return available[0];
  if (available.length === 2) return available[0]; // lower of two (sorted ascending)
  return available[1]; // middle of three (sorted ascending)
}

/**
 * ASM-003 qualifying score across the file: each borrower's middle score, then
 * the LOWER across borrowers ("lower of the two borrowers' middle scores");
 * a single-borrower file qualifies at that borrower's own middle score.
 * Borrowers with no available scores are skipped; null when nobody has one.
 */
export function qualifyingCreditScore(
  scores: ReadonlyArray<readonly BureauScoreInput[]>,
): number | null {
  let qualifying: number | null = null;
  for (const borrowerScores of scores) {
    const middle = middleBureauScore(borrowerScores);
    if (middle === null) continue;
    qualifying = qualifying === null ? middle : Math.min(qualifying, middle);
  }
  return qualifying;
}

// ---------------------------------------------------------------------------
// Composed qualification
// ---------------------------------------------------------------------------

/**
 * The composed §E evaluation: DTI + LTV + CLTV plus warning/block checks
 * against the PASSED-IN thresholds (callers source them from SystemConfig —
 * "Warning > 80%, block > 97% (both from SystemConfig)"; DTI "Warning > 43%").
 * Comparisons run on the rounded 3-dp values — the same values every consumer
 * displays and stores (AC-13).
 */
export function computeQualification(
  input: QualificationInput,
  thresholds: QualificationThresholds,
): QualificationResult {
  const dti = computeDti(input);
  const ltv = computeLtv(input);
  const cltv = computeCltv(input);
  return {
    dti,
    ltv,
    cltv,
    dtiWarning: dti !== null && dti > thresholds.dtiWarningPercent,
    ltvWarning: ltv !== null && ltv > thresholds.ltvWarningPercent,
    ltvSubmissionBlocked: ltv !== null && ltv > thresholds.ltvSubmissionBlockPercent,
  };
}
