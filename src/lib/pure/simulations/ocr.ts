// §6.3.7 Document OCR / AI extraction — the deterministic PURE core (task-034,
// REQ-067, INT-008, INT-019). No DB, no clock, no env: every input arrives as
// an argument, and identical inputs always produce identical outputs (§6.1 —
// all "random-looking" values are FNV-1a hashes of the documented seed
// material: the file's content hash + field path).
//
// INPUT → OUTPUT MAPPING (the §6.3 delivery mapping document for row 7):
//   1. File-name fault triggers (case-insensitive substring of the original
//      file name; always active):
//        "fail"     → the extraction FAILS. Retryable on attempts 1–2, NON-
//                     retryable from attempt 3 — so with automatic retries the
//                     job ends `failed` after exactly 2 automatic retries
//                     (§6.3.7 "`fail` → job fails after 2 automatic retries").
//        "slow"     → 45,000 ms processing latency (§6.3.7 "45 s processing").
//        "blurry"   → every confidence drawn from 30–55 (red, <60).
//        "mismatch" → the mapped income/balance figures are extracted 30%
//                     HIGHER than the entered values (variance 30% > the §4.7
//                     20%/25% thresholds → ocr-mismatch fraud flag).
//   2. Fixture table: when the file name contains a fixture's token AND the
//      document type matches, the fixture's values are returned with
//      confidence 90–98 ("files matching seeded fixture names return their
//      fixture values"). The task-043 seed names its seeded files after these
//      tokens.
//   3. Otherwise: values are DERIVED FROM THE APPLICATION'S OWN ENTERED DATA
//      (so the comparison view matches) with confidence 75–92; where a piece
//      of entered data is absent, a deterministic synthetic filler is used and
//      the field is NOT mapped (nothing to compare).
//   Latency: 4,000 ms ± 2,000 deterministic jitter from the content hash
//   (§6.3.7 "4 s ± 2"), except `slow`.
//
// FIELD PATHS: mapped fields use the terminal-segment tokens the task-027
// fraud predicates classify (src/lib/services/fraud.ts classifyOcrFieldPath):
// "employment.employerName", "employment.baseMonthlyIncome",
// "account.endingBalance", "borrower.name", "borrower.dateOfBirth",
// "taxreturn.filerName" (name kind). Raw per-type figures that have no
// like-for-like entered counterpart (annual wages, per-period gross pay, AGI,
// total deposits …) deliberately carry NO enteredValue so the §4.7 predicates
// skip them — comparing an annual figure to a monthly one would fabricate
// variance.

import { seededInt } from "@/lib/pure/simulations/shared";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Mirrors contracts §A OcrFieldResult, field names verbatim. */
export interface OcrExtractedField {
  fieldPath: string;
  extractedValue: string;
  enteredValue?: string;
  confidence: number;
  variancePct?: number;
  mapped?: boolean;
}

/** The slice of the application's ENTERED data the extraction derives from. */
export interface OcrEnteredData {
  /** Primary borrower full name ("First Last"). */
  borrowerFullName: string | null;
  /**
   * Primary borrower DOB in the "Mon D, YYYY" DISPLAY form. The caller decrypts
   * the stored value (NFR-002) and converts it at the service boundary
   * (document-ocr.ts assembleEnteredData) — the raw ISO DOB never reaches this
   * module, because everything emitted here is persisted to the unencrypted
   * OcrExtraction.fields column and serialised to staff (NFR-003 / SEC-2).
   */
  dateOfBirth: string | null;
  ssnLast4: string | null;
  /** First employment record of the primary borrower. */
  employerName: string | null;
  baseMonthlyIncome: number | null;
  /** First asset record. */
  bankInstitution: string | null;
  accountLast4: string | null;
  accountBalance: number | null;
  /** First gift-type other-credit record. */
  giftDonor: string | null;
  giftAmount: number | null;
}

export interface OcrSimulationInput {
  /** contracts.json enums.DocumentType value. */
  documentType: string;
  fileName: string;
  /** Hex SHA-256 of the file content (DocumentVersion.sha256) — the seed. */
  contentSha256: string;
  /** 1-based attempt counter (the `fail` trigger keys on it). */
  attempt: number;
  /** Date anchor for derived dates (tax year, statement period, expiry). */
  referenceDate: Date;
  entered: OcrEnteredData;
}

export interface OcrSimulationFailure {
  code: "unavailable" | "timeout" | "invalid-response";
  message: string;
  retryable: boolean;
}

export type OcrSimulationOutcome =
  | { ok: true; fields: OcrExtractedField[]; rawText: string; latencyMs: number }
  | { ok: false; failure: OcrSimulationFailure; latencyMs: number };

// ---------------------------------------------------------------------------
// Constants (§6.3.7)
// ---------------------------------------------------------------------------

export const OCR_BASE_LATENCY_MS = 4000;
export const OCR_LATENCY_JITTER_MS = 2000;
export const OCR_SLOW_LATENCY_MS = 45_000;
/** `fail`-trigger files stop retrying from this attempt (2 automatic retries). */
export const OCR_FAIL_TRIGGER_MAX_RETRYABLE_ATTEMPT = 2;
/** `mismatch`-trigger files extract income/balance 30% off the entered value. */
export const OCR_MISMATCH_FACTOR = 1.3;

/** Confidence bands by tier. */
const CONF_FIXTURE: readonly [number, number] = [90, 98];
const CONF_DERIVED: readonly [number, number] = [75, 92];
const CONF_BLURRY: readonly [number, number] = [30, 55];

// ---------------------------------------------------------------------------
// Fixture table (token-keyed — the task-043 seed names files after these)
// ---------------------------------------------------------------------------

export interface OcrFixture {
  /** Case-insensitive file-name marker that selects this fixture. (Named
   *  'marker', not 'token': a key named token holding a string literal trips
   *  static-analysis secret-detection rules — these are file-name selectors
   *  for the deterministic simulation, not credentials.) */
  marker: string;
  documentType: string;
  /** fieldPath → extracted value (mapped paths compare against entered data). */
  values: Record<string, string>;
}

export const OCR_FIXTURES: readonly OcrFixture[] = [
  {
    marker: "fixture-w2-northwind",
    documentType: "w2",
    values: {
      "employment.employerName": "Northwind Traders LLC",
      "w2.employerEin": "**-***1204",
      "w2.employeeSsnLast4": "6789",
      "w2.wagesBox1": "$91,200.00",
      "w2.federalTaxWithheld": "$14,592.00",
      "w2.taxYear": "2025",
      "employment.baseMonthlyIncome": "$7,600.00",
    },
  },
  {
    marker: "fixture-paystub-northwind",
    documentType: "pay-stub",
    values: {
      "employment.employerName": "Northwind Traders LLC",
      "paystub.payPeriodStart": "2026-08-01",
      "paystub.payPeriodEnd": "2026-08-15",
      "paystub.payDate": "2026-08-20",
      "paystub.grossPay": "$3,800.00",
      "paystub.netPay": "$2,964.00",
      "paystub.ytdGross": "$60,800.00",
      "paystub.payFrequency": "semi-monthly",
      "employment.baseMonthlyIncome": "$7,600.00",
    },
  },
  {
    marker: "fixture-bank-contoso",
    documentType: "bank-statement",
    values: {
      "bank.institution": "Contoso Federal Savings",
      "bank.accountLast4": "4821",
      "bank.statementPeriod": "2026-07-01 to 2026-07-31",
      "account.endingBalance": "$42,318.55",
      "bank.totalDeposits": "$9,140.22",
    },
  },
  {
    marker: "fixture-1040-return",
    documentType: "tax-return-1040",
    values: {
      "taxreturn.filerName": "Jordan Q. Fixture",
      "taxreturn.taxYear": "2025",
      "taxreturn.adjustedGrossIncome": "$88,450.00",
      "taxreturn.totalIncome": "$92,150.00",
    },
  },
  {
    marker: "fixture-id-license",
    documentType: "government-id",
    values: {
      "borrower.name": "Jordan Q. Fixture",
      // Display form, matching the shape live entered DOBs arrive in (NFR-003).
      "borrower.dateOfBirth": "Apr 12, 1988",
      "id.numberLast4": "7731",
      "id.expirationDate": "2029-04-12",
    },
  },
  {
    marker: "fixture-gift-letter",
    documentType: "gift-letter",
    values: {
      "gift.donorName": "Casey Fixture",
      "gift.amount": "$15,000.00",
      "gift.relationship": "Parent",
    },
  },
];

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoDaysFrom(referenceDate: Date, days: number): string {
  return new Date(referenceDate.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * DOB display form, "Mon D, YYYY" (NFR-003 / SEC-2 — the raw ISO DOB never
 * leaves the identity-own endpoint, and OcrExtraction.fields is an unencrypted
 * column serialised verbatim to staff). The month table is duplicated from
 * @/lib/crypto/masking on purpose: this module is a declared PURE core (no DB,
 * no clock, no env) whose only import is @/lib/pure/simulations/shared, so it
 * must not reach into the crypto layer. Both sides of the §4.7 DOB comparison
 * move together — live entered DOBs are converted to this same shape at the
 * service boundary (document-ocr.ts assembleEnteredData) — so the
 * string-equality DOB match in services/fraud.ts stays meaningful.
 */
const DOB_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function dobDisplay(year: number, month: number, day: number): string {
  return `${DOB_MONTHS[month - 1]} ${day}, ${year}`;
}

/** Deterministic n-digit numeric string from the seed (synthetic fillers). */
function seededDigits(seed: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i += 1) out += String(seededInt(`${seed}|d${i}`, 0, 9));
  return out;
}

function hasToken(fileName: string, token: string): boolean {
  return fileName.toLowerCase().includes(token);
}

// ---------------------------------------------------------------------------
// Field assembly
// ---------------------------------------------------------------------------

interface FieldSpec {
  fieldPath: string;
  extractedValue: string;
  /** Entered counterpart (comparison view + §4.7 predicates); null = unmapped. */
  enteredValue?: string | null;
  /** Numeric pair for variance (extracted, entered) when both are numbers. */
  numeric?: { extracted: number; entered: number };
}

function buildField(
  spec: FieldSpec,
  contentSha256: string,
  confBand: readonly [number, number],
): OcrExtractedField {
  const field: OcrExtractedField = {
    fieldPath: spec.fieldPath,
    extractedValue: spec.extractedValue,
    confidence: seededInt(`ocr|conf|${contentSha256}|${spec.fieldPath}`, confBand[0], confBand[1]),
  };
  if (spec.enteredValue != null) {
    field.enteredValue = spec.enteredValue;
    field.mapped = true;
    if (spec.numeric && spec.numeric.entered !== 0) {
      field.variancePct = round2(
        (Math.abs(spec.numeric.extracted - spec.numeric.entered) / Math.abs(spec.numeric.entered)) * 100,
      );
    }
  } else {
    field.mapped = false;
  }
  return field;
}

/** Entered-data-derived field specs per document type (§4.7 target lists). */
function derivedFieldSpecs(input: OcrSimulationInput, mismatch: boolean): FieldSpec[] {
  const { documentType, contentSha256: sha, referenceDate, entered } = input;
  const seed = `ocr|${sha}`;
  const year = referenceDate.getUTCFullYear();

  const employer = entered.employerName ?? `Meridian ${seededDigits(seed, 3)} Industries`;
  const employerMapped = entered.employerName != null;
  const monthly = entered.baseMonthlyIncome ?? seededInt(`${seed}|inc`, 4200, 9800);
  const monthlyMapped = entered.baseMonthlyIncome != null;
  const extractedMonthly = round2(mismatch ? monthly * OCR_MISMATCH_FACTOR : monthly);
  const monthlySpec: FieldSpec = {
    fieldPath: "employment.baseMonthlyIncome",
    extractedValue: usd(extractedMonthly),
    enteredValue: monthlyMapped ? usd(monthly) : null,
    numeric: monthlyMapped ? { extracted: extractedMonthly, entered: monthly } : undefined,
  };

  switch (documentType) {
    case "w2": {
      const wages = round2(extractedMonthly * 12);
      return [
        {
          fieldPath: "employment.employerName",
          extractedValue: employer,
          enteredValue: employerMapped ? entered.employerName : null,
        },
        { fieldPath: "w2.employerEin", extractedValue: `**-***${seededDigits(`${seed}|ein`, 4)}` },
        {
          fieldPath: "w2.employeeSsnLast4",
          extractedValue: entered.ssnLast4 ?? seededDigits(`${seed}|ssn`, 4),
        },
        { fieldPath: "w2.wagesBox1", extractedValue: usd(wages) },
        { fieldPath: "w2.federalTaxWithheld", extractedValue: usd(round2(wages * 0.16)) },
        { fieldPath: "w2.taxYear", extractedValue: String(year - 1) },
        monthlySpec,
      ];
    }
    case "pay-stub": {
      const frequencies = [
        { label: "bi-weekly", periodsPerYear: 26 },
        { label: "semi-monthly", periodsPerYear: 24 },
        { label: "monthly", periodsPerYear: 12 },
      ] as const;
      const frequency = frequencies[seededInt(`${seed}|freq`, 0, frequencies.length - 1)]!;
      const gross = round2((extractedMonthly * 12) / frequency.periodsPerYear);
      const periodDays = Math.round(365 / frequency.periodsPerYear);
      return [
        {
          fieldPath: "employment.employerName",
          extractedValue: employer,
          enteredValue: employerMapped ? entered.employerName : null,
        },
        { fieldPath: "paystub.payPeriodStart", extractedValue: isoDaysFrom(referenceDate, -(periodDays + 5)) },
        { fieldPath: "paystub.payPeriodEnd", extractedValue: isoDaysFrom(referenceDate, -6) },
        { fieldPath: "paystub.payDate", extractedValue: isoDaysFrom(referenceDate, -1) },
        { fieldPath: "paystub.grossPay", extractedValue: usd(gross) },
        { fieldPath: "paystub.netPay", extractedValue: usd(round2(gross * 0.78)) },
        {
          fieldPath: "paystub.ytdGross",
          extractedValue: usd(round2(gross * seededInt(`${seed}|ytd`, 8, 20))),
        },
        { fieldPath: "paystub.payFrequency", extractedValue: frequency.label },
        monthlySpec,
      ];
    }
    case "bank-statement": {
      const institution = entered.bankInstitution ?? `First ${seededDigits(seed, 3)} Bank`;
      const balance = entered.accountBalance ?? seededInt(`${seed}|bal`, 2500, 78_000);
      const balanceMapped = entered.accountBalance != null;
      const extractedBalance = round2(mismatch ? balance * OCR_MISMATCH_FACTOR : balance);
      return [
        {
          fieldPath: "bank.institution",
          extractedValue: institution,
          enteredValue: entered.bankInstitution != null ? entered.bankInstitution : null,
        },
        {
          fieldPath: "bank.accountLast4",
          extractedValue: entered.accountLast4 ?? seededDigits(`${seed}|acct`, 4),
        },
        {
          fieldPath: "bank.statementPeriod",
          extractedValue: `${isoDaysFrom(referenceDate, -35)} to ${isoDaysFrom(referenceDate, -5)}`,
        },
        {
          fieldPath: "account.endingBalance",
          extractedValue: usd(extractedBalance),
          enteredValue: balanceMapped ? usd(balance) : null,
          numeric: balanceMapped ? { extracted: extractedBalance, entered: balance } : undefined,
        },
        {
          fieldPath: "bank.totalDeposits",
          extractedValue: usd(round2(extractedBalance * (seededInt(`${seed}|dep`, 18, 42) / 100))),
        },
      ];
    }
    case "tax-return-1040": {
      const name = entered.borrowerFullName ?? `Taylor ${seededDigits(seed, 2)} Sample`;
      const agi = round2(extractedMonthly * 12 * 0.94);
      return [
        {
          fieldPath: "taxreturn.filerName",
          extractedValue: name,
          enteredValue: entered.borrowerFullName != null ? entered.borrowerFullName : null,
        },
        { fieldPath: "taxreturn.taxYear", extractedValue: String(year - 1) },
        { fieldPath: "taxreturn.adjustedGrossIncome", extractedValue: usd(agi) },
        { fieldPath: "taxreturn.totalIncome", extractedValue: usd(round2(extractedMonthly * 12)) },
      ];
    }
    case "government-id": {
      const name = entered.borrowerFullName ?? `Taylor ${seededDigits(seed, 2)} Sample`;
      // Synthetic fallback in the SAME display shape as a live entered DOB, so
      // the §4.7 DOB comparison compares like with like (NFR-003).
      const dob =
        entered.dateOfBirth ??
        dobDisplay(
          1900 + seededInt(`${seed}|yy`, 60, 99),
          seededInt(`${seed}|mm`, 1, 9),
          10 + seededInt(`${seed}|dd`, 0, 9),
        );
      return [
        {
          fieldPath: "borrower.name",
          extractedValue: name,
          enteredValue: entered.borrowerFullName != null ? entered.borrowerFullName : null,
        },
        {
          fieldPath: "borrower.dateOfBirth",
          extractedValue: dob,
          enteredValue: entered.dateOfBirth != null ? entered.dateOfBirth : null,
        },
        { fieldPath: "id.numberLast4", extractedValue: seededDigits(`${seed}|idnum`, 4) },
        {
          fieldPath: "id.expirationDate",
          extractedValue: isoDaysFrom(referenceDate, 365 * 3 + seededInt(`${seed}|exp`, 0, 300)),
        },
      ];
    }
    case "gift-letter": {
      const donor = entered.giftDonor ?? `Morgan ${seededDigits(seed, 2)} Giver`;
      const amount = entered.giftAmount ?? seededInt(`${seed}|gift`, 5000, 40_000);
      const amountMapped = entered.giftAmount != null;
      const relationships = ["Parent", "Sibling", "Grandparent", "Relative"] as const;
      return [
        {
          fieldPath: "gift.donorName",
          extractedValue: donor,
          enteredValue: entered.giftDonor != null ? entered.giftDonor : null,
        },
        {
          fieldPath: "gift.amount",
          extractedValue: usd(round2(amount)),
          enteredValue: amountMapped ? usd(amount) : null,
          numeric: amountMapped ? { extracted: round2(amount), entered: amount } : undefined,
        },
        {
          fieldPath: "gift.relationship",
          extractedValue: relationships[seededInt(`${seed}|rel`, 0, relationships.length - 1)]!,
        },
      ];
    }
    default:
      // §6.3.7 defines extraction targets only for the six types above; other
      // document types complete with an empty structured field set (manual
      // review — the panel shows "no extraction targets for this type").
      return [];
  }
}

/** Fixture field specs — fixture values, entered counterparts where mapped paths have entered data. */
function fixtureFieldSpecs(fixture: OcrFixture, entered: OcrEnteredData): FieldSpec[] {
  const enteredByPath: Record<string, { value: string | null; numeric: number | null }> = {
    "employment.employerName": { value: entered.employerName, numeric: null },
    "employment.baseMonthlyIncome": {
      value: entered.baseMonthlyIncome != null ? usd(entered.baseMonthlyIncome) : null,
      numeric: entered.baseMonthlyIncome,
    },
    "account.endingBalance": {
      value: entered.accountBalance != null ? usd(entered.accountBalance) : null,
      numeric: entered.accountBalance,
    },
    "bank.institution": { value: entered.bankInstitution, numeric: null },
    "borrower.name": { value: entered.borrowerFullName, numeric: null },
    "taxreturn.filerName": { value: entered.borrowerFullName, numeric: null },
    "borrower.dateOfBirth": { value: entered.dateOfBirth, numeric: null },
    "gift.donorName": { value: entered.giftDonor, numeric: null },
    "gift.amount": {
      value: entered.giftAmount != null ? usd(entered.giftAmount) : null,
      numeric: entered.giftAmount,
    },
  };
  return Object.entries(fixture.values).map(([fieldPath, extractedValue]) => {
    const counterpart = enteredByPath[fieldPath];
    const spec: FieldSpec = { fieldPath, extractedValue, enteredValue: counterpart?.value ?? null };
    if (counterpart?.numeric != null) {
      const parsed = Number(extractedValue.replace(/[$,\s]/g, ""));
      if (Number.isFinite(parsed)) {
        spec.numeric = { extracted: parsed, entered: counterpart.numeric };
      }
    }
    return spec;
  });
}

// ---------------------------------------------------------------------------
// simulateOcrExtraction — the single entry point
// ---------------------------------------------------------------------------

export function ocrLatencyMs(fileName: string, contentSha256: string): number {
  if (hasToken(fileName, "slow")) return OCR_SLOW_LATENCY_MS;
  const jitter =
    (seededInt(`ocr|lat|${contentSha256}`, 0, 2 * OCR_LATENCY_JITTER_MS) - OCR_LATENCY_JITTER_MS);
  return OCR_BASE_LATENCY_MS + jitter;
}

export function simulateOcrExtraction(input: OcrSimulationInput): OcrSimulationOutcome {
  const latencyMs = ocrLatencyMs(input.fileName, input.contentSha256);

  if (hasToken(input.fileName, "fail")) {
    return {
      ok: false,
      failure: {
        code: "unavailable",
        message:
          "Simulated extraction failure ('fail' trigger): the document intelligence service could not process this file.",
        retryable: input.attempt <= OCR_FAIL_TRIGGER_MAX_RETRYABLE_ATTEMPT,
      },
      latencyMs,
    };
  }

  const blurry = hasToken(input.fileName, "blurry");
  const mismatch = hasToken(input.fileName, "mismatch");

  const fixture = OCR_FIXTURES.find(
    (f) => f.documentType === input.documentType && hasToken(input.fileName, f.marker),
  );
  const confBand = blurry ? CONF_BLURRY : fixture ? CONF_FIXTURE : CONF_DERIVED;
  const specs = fixture
    ? fixtureFieldSpecs(fixture, input.entered)
    : derivedFieldSpecs(input, mismatch);

  const fields = specs.map((spec) => buildField(spec, input.contentSha256, confBand));
  const rawText =
    fields.length === 0
      ? `No structured extraction targets are defined for document type "${input.documentType}".`
      : fields.map((f) => `${f.fieldPath}: ${f.extractedValue}`).join("\n");

  return { ok: true, fields, rawText, latencyMs };
}
