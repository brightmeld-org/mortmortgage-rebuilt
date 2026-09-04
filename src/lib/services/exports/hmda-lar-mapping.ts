// HMDA LAR field mapping — the ASM-010 machine-readable mapping artifact for
// task-042 (REQ-076 / DATA-003 / RFP §4.9.4 / §5.3, ASM-005 filing-year spec).
//
// This module is the single authority the LAR builder (hmda-lar.ts) AND the
// task-042 evidence suite both read: the ordered field list of the FFIEC
// pipe-delimited LAR record (2018-format layout, unchanged through the 2026
// filing year), the transmittal-sheet (header) field list, and every
// application-value -> HMDA-code table, including the documented
// "not applicable" / exempt codes for values this system does not collect
// (RFP §4.9.4: "Values not collected are populated with the specification's
// 'not applicable' or 'exempt' codes; the mapping is documented").
//
// Sources for every mapped value are contracts.json field names verbatim
// (FIELD-NAME EXACTNESS rule); the HMDA code literals are the FFIEC filing
// instructions' published valid values.

import type { AusRecommendation } from "@/lib/pure/simulations/check-results";
import type { MANUFACTURED_HOME_LAND_INTERESTS } from "@/lib/schemas/application";

/** contracts.json enums.ManufacturedHomeLandInterest (CH-011 / VR-135). */
export type ManufacturedHomeLandInterest = (typeof MANUFACTURED_HOME_LAND_INTERESTS)[number];

// ---------------------------------------------------------------------------
// Field specs
// ---------------------------------------------------------------------------

export interface LarFieldSpec {
  /** 1-based position in the pipe-delimited LAR record. */
  index: number;
  /** FFIEC data-point name. */
  name: string;
  /** Where the value comes from (contracts.json path, code table, or fixed code). */
  source: string;
  /**
   * Present when the field can carry a spec "not applicable"/exempt code (or a
   * spec-mandated constant) — the LIVE-STATE rule's documented exception list.
   */
  notCollected?: { code: string; justification: string };
}

/** Number of pipe-delimited fields in one LAR record (2018+ FFIEC layout). */
export const LAR_FIELD_COUNT = 110;

/** Number of pipe-delimited fields in the transmittal-sheet header record. */
export const TS_FIELD_COUNT = 15;

/** Transmittal sheet (record identifier 1) — one header record per file. */
export const TS_FIELDS: readonly LarFieldSpec[] = [
  { index: 1, name: "Record Identifier", source: "constant \"1\"" },
  {
    index: 2,
    name: "Financial Institution Name",
    source: "constant \"MortMortgage\"",
    notCollected: { code: "MortMortgage", justification: "no institution-name SystemConfig key exists; the product name is the documented constant" },
  },
  { index: 3, name: "Calendar Year", source: "?year request parameter" },
  { index: 4, name: "Calendar Quarter", source: "constant \"4\"", notCollected: { code: "4", justification: "annual submission per the FFIEC spec" } },
  { index: 5, name: "Contact Person's Name", source: "not collected", notCollected: { code: "NA", justification: "no compliance-contact fields exist in the system" } },
  { index: 6, name: "Contact Person's Phone Number", source: "not collected", notCollected: { code: "NA", justification: "no compliance-contact fields exist in the system" } },
  { index: 7, name: "Contact Person's Email Address", source: "not collected", notCollected: { code: "NA", justification: "no compliance-contact fields exist in the system" } },
  { index: 8, name: "Contact Person's Office Street Address", source: "not collected", notCollected: { code: "NA", justification: "no compliance-contact fields exist in the system" } },
  { index: 9, name: "Contact Person's Office City", source: "not collected", notCollected: { code: "NA", justification: "no compliance-contact fields exist in the system" } },
  { index: 10, name: "Contact Person's Office State", source: "not collected", notCollected: { code: "NA", justification: "no compliance-contact fields exist in the system" } },
  { index: 11, name: "Contact Person's Office Zip Code", source: "not collected", notCollected: { code: "NA", justification: "no compliance-contact fields exist in the system" } },
  { index: 12, name: "Federal Agency", source: "SystemConfig hmda.agencyCode (409 until set)" },
  { index: 13, name: "Total Number of Entries", source: "COUNT of reportable applications for the selected year (aggregate query)" },
  { index: 14, name: "Federal Taxpayer Identification Number", source: "not collected", notCollected: { code: "NA", justification: "no TIN is captured anywhere in the system" } },
  { index: 15, name: "Legal Entity Identifier (LEI)", source: "SystemConfig hmda.lei (409 until set)" },
];

/** LAR record (record identifier 2) — one per reportable application. */
export const LAR_FIELDS: readonly LarFieldSpec[] = [
  { index: 1, name: "Record Identifier", source: "constant \"2\"" },
  { index: 2, name: "Legal Entity Identifier (LEI)", source: "SystemConfig hmda.lei" },
  { index: 3, name: "Universal Loan Identifier (ULI)", source: "LEI + applicationNumber (hyphens stripped) + ISO 7064 MOD 97-10 check digits" },
  { index: 4, name: "Application Date", source: "Application.submittedAt as YYYYMMDD in America/New_York", notCollected: { code: "NA", justification: "submittedAt null (never expected for a reportable application)" } },
  { index: 5, name: "Loan Type", source: "LoanDetails.loanType via HMDA_LOAN_TYPE" },
  { index: 6, name: "Loan Purpose", source: "LoanDetails.loanPurpose via HMDA_LOAN_PURPOSE" },
  { index: 7, name: "Preapproval", source: "constant \"2\"", notCollected: { code: "2", justification: "no preapproval-request program exists in the system" } },
  { index: 8, name: "Construction Method", source: "2 when SubjectProperty.propertyType = manufactured-home or manufacturedHome = true, else 1" },
  { index: 9, name: "Occupancy Type", source: "SubjectProperty.occupancy via HMDA_OCCUPANCY", notCollected: { code: "1", justification: "occupancy absent -> principal residence (URLA default; the spec has no NA code for occupancy)" } },
  { index: 10, name: "Loan Amount", source: "LoanDetails.requestedLoanAmount", notCollected: { code: "NA", justification: "amount never saved on the application" } },
  { index: 11, name: "Action Taken", source: "workflowState/outcome via HMDA_ACTION_TAKEN (ASM-005)" },
  { index: 12, name: "Action Taken Date", source: "decidedAt (decided) or stateEnteredAt (withdrawn / declined_by_borrower) as YYYYMMDD in America/New_York" },
  { index: 13, name: "Street Address", source: "SubjectProperty.address.street (+ unit), pipe-sanitized", notCollected: { code: "NA", justification: "address never saved" } },
  { index: 14, name: "City", source: "SubjectProperty.address.city, pipe-sanitized", notCollected: { code: "NA", justification: "address never saved" } },
  { index: 15, name: "State", source: "SubjectProperty.address.state", notCollected: { code: "NA", justification: "address never saved" } },
  { index: 16, name: "Zip Code", source: "SubjectProperty.address.zip", notCollected: { code: "NA", justification: "address never saved" } },
  { index: 17, name: "County", source: "first 5 digits of SubjectProperty.geocode.censusTract (synthetic SSCCC FIPS from the task-015 geocode)", notCollected: { code: "NA", justification: "no stored geocode" } },
  { index: 18, name: "Census Tract", source: "SubjectProperty.geocode.censusTract with dots stripped (11 digits, stored geocode)", notCollected: { code: "NA", justification: "no stored geocode" } },
  { index: 19, name: "Ethnicity of Applicant 1", source: "borrower 1 Demographics.ethnicity[0] via HMDA_ETHNICITY", notCollected: { code: "3", justification: "not provided / demographics never captured" } },
  { index: 20, name: "Ethnicity of Applicant 2", source: "borrower 1 Demographics.ethnicity[1]" },
  { index: 21, name: "Ethnicity of Applicant 3", source: "borrower 1 Demographics.ethnicity[2]" },
  { index: 22, name: "Ethnicity of Applicant 4", source: "borrower 1 Demographics.ethnicity[3]" },
  { index: 23, name: "Ethnicity of Applicant 5", source: "borrower 1 Demographics.ethnicity[4]" },
  { index: 24, name: "Ethnicity of Applicant: Free Form Text for Other Hispanic or Latino", source: "borrower 1 Demographics.ethnicityOtherDetail, pipe-sanitized" },
  { index: 25, name: "Ethnicity of Co-Applicant 1", source: "borrower 2 Demographics.ethnicity[0]", notCollected: { code: "5", justification: "no co-applicant" } },
  { index: 26, name: "Ethnicity of Co-Applicant 2", source: "borrower 2 Demographics.ethnicity[1]" },
  { index: 27, name: "Ethnicity of Co-Applicant 3", source: "borrower 2 Demographics.ethnicity[2]" },
  { index: 28, name: "Ethnicity of Co-Applicant 4", source: "borrower 2 Demographics.ethnicity[3]" },
  { index: 29, name: "Ethnicity of Co-Applicant 5", source: "borrower 2 Demographics.ethnicity[4]" },
  { index: 30, name: "Ethnicity of Co-Applicant: Free Form Text for Other Hispanic or Latino", source: "borrower 2 Demographics.ethnicityOtherDetail, pipe-sanitized" },
  { index: 31, name: "Ethnicity of Applicant Collected on the Basis of Visual Observation or Surname", source: "2 when provided, 3 when not provided (DATA-003: electronic collection, never visual observation)" },
  { index: 32, name: "Ethnicity of Co-Applicant Collected on the Basis of Visual Observation or Surname", source: "2 provided / 3 not provided / 4 no co-applicant" },
  { index: 33, name: "Race of Applicant 1", source: "borrower 1 Demographics.race[0] via HMDA_RACE", notCollected: { code: "6", justification: "not provided / demographics never captured" } },
  { index: 34, name: "Race of Applicant 2", source: "borrower 1 Demographics.race[1]" },
  { index: 35, name: "Race of Applicant 3", source: "borrower 1 Demographics.race[2]" },
  { index: 36, name: "Race of Applicant 4", source: "borrower 1 Demographics.race[3]" },
  { index: 37, name: "Race of Applicant 5", source: "borrower 1 Demographics.race[4]" },
  { index: 38, name: "Race of Applicant: Free Form Text for American Indian or Alaska Native Enrolled or Principal Tribe", source: "borrower 1 Demographics.raceOtherDetails assigned in order to selected free-form slots (tribe, other Asian, other Pacific Islander)" },
  { index: 39, name: "Race of Applicant: Free Form Text for Other Asian", source: "borrower 1 Demographics.raceOtherDetails (see field 38)" },
  { index: 40, name: "Race of Applicant: Free Form Text for Other Pacific Islander", source: "borrower 1 Demographics.raceOtherDetails (see field 38)" },
  { index: 41, name: "Race of Co-Applicant 1", source: "borrower 2 Demographics.race[0]", notCollected: { code: "8", justification: "no co-applicant" } },
  { index: 42, name: "Race of Co-Applicant 2", source: "borrower 2 Demographics.race[1]" },
  { index: 43, name: "Race of Co-Applicant 3", source: "borrower 2 Demographics.race[2]" },
  { index: 44, name: "Race of Co-Applicant 4", source: "borrower 2 Demographics.race[3]" },
  { index: 45, name: "Race of Co-Applicant 5", source: "borrower 2 Demographics.race[4]" },
  { index: 46, name: "Race of Co-Applicant: Free Form Text for Tribe", source: "borrower 2 Demographics.raceOtherDetails" },
  { index: 47, name: "Race of Co-Applicant: Free Form Text for Other Asian", source: "borrower 2 Demographics.raceOtherDetails" },
  { index: 48, name: "Race of Co-Applicant: Free Form Text for Other Pacific Islander", source: "borrower 2 Demographics.raceOtherDetails" },
  { index: 49, name: "Race of Applicant Collected on the Basis of Visual Observation or Surname", source: "2 provided / 3 not provided (DATA-003)" },
  { index: 50, name: "Race of Co-Applicant Collected on the Basis of Visual Observation or Surname", source: "2 provided / 3 not provided / 4 no co-applicant" },
  { index: 51, name: "Sex of Applicant", source: "borrower 1 Demographics.sex via HMDA_SEX", notCollected: { code: "3", justification: "not provided / demographics never captured" } },
  { index: 52, name: "Sex of Co-Applicant", source: "borrower 2 Demographics.sex", notCollected: { code: "5", justification: "no co-applicant" } },
  { index: 53, name: "Sex of Applicant Collected on the Basis of Visual Observation or Surname", source: "2 provided / 3 not provided (DATA-003)" },
  { index: 54, name: "Sex of Co-Applicant Collected on the Basis of Visual Observation or Surname", source: "2 provided / 3 not provided / 4 no co-applicant" },
  { index: 55, name: "Age of Applicant", source: "borrower 1 decrypted DOB -> whole years at Application.submittedAt (America/New_York calendar dates; Feb-29 birthdays complete Mar 1 in non-leap years)", notCollected: { code: "8888", justification: "DOB never captured" } },
  { index: 56, name: "Age of Co-Applicant", source: "borrower 2 age at application date", notCollected: { code: "9999", justification: "no co-applicant (8888 when co-applicant DOB never captured)" } },
  { index: 57, name: "Income", source: "shared task-010 monthly income (monthlyIncomeCents over the SEC-7 DTI income enumeration) x 12, in thousands, rounded", notCollected: { code: "NA", justification: "no income rows saved (monthly income 0)" } },
  { index: 58, name: "Type of Purchaser", source: "constant \"0\"", notCollected: { code: "0", justification: "loans are never originated/sold in this system" } },
  { index: 59, name: "Rate Spread", source: "not derivable", notCollected: { code: "NA", justification: "no APOR dataset exists to compute a spread against" } },
  { index: 60, name: "HOEPA Status", source: "constant \"3\"", notCollected: { code: "3", justification: "not applicable — loans are never originated" } },
  { index: 61, name: "Lien Status", source: "constant \"1\"", notCollected: { code: "1", justification: "every application is for a first-lien mortgage (subordinate liens are CLTV inputs only)" } },
  { index: 62, name: "Credit Score of Applicant", source: "ASM-003 qualifying score (lower of borrowers' middle scores) from the latest completed non-superseded credit check", notCollected: { code: "8888", justification: "no completed credit check" } },
  { index: 63, name: "Credit Score of Co-Applicant", source: "9999 no co-applicant / 8888 otherwise", notCollected: { code: "8888", justification: "one file-level qualifying score is relied on (ASM-003), no separate co-applicant score" } },
  { index: 64, name: "Applicant Credit Score Model", source: "8 (Other) when a score is reported, 9 (NA) when 8888" },
  { index: 65, name: "Applicant Credit Score Model: Free Form Text", source: "constant \"Simulated tri-bureau middle score\" when model = 8 (spec requires free-form for code 8)" },
  { index: 66, name: "Co-Applicant Credit Score Model", source: "10 no co-applicant / 9 (NA) otherwise" },
  { index: 67, name: "Co-Applicant Credit Score Model: Free Form Text", source: "blank" },
  { index: 68, name: "Reason for Denial 1", source: "deciding deny ApprovalRecord.denialReasons[0] via HMDA_DENIAL_REASON", notCollected: { code: "10", justification: "not applicable — action taken is not a denial" } },
  { index: 69, name: "Reason for Denial 2", source: "denialReasons[1]" },
  { index: 70, name: "Reason for Denial 3", source: "denialReasons[2]" },
  { index: 71, name: "Reason for Denial 4", source: "denialReasons[3]" },
  { index: 72, name: "Reason for Denial: Free Form Text", source: "ApprovalRecord.denialReasonOtherText when a reason is \"other\", pipe-sanitized" },
  // Fields 73-77 are the Closing-Disclosure-derived money data points. Reg C
  // §1003.4(a)(17)(i), (18), (19) and (20) define each one BY REFERENCE to the
  // Closing Disclosure (12 CFR §1026.38(f)(1), (f)(4) and (h)(3)), which is
  // issued only for a CONSUMMATED transaction. Under ASM-005 / INV-043 this
  // system never originates a loan (action taken is only 2 / 3 / 4), so no
  // Closing Disclosure is ever issued and all five report the specification's
  // "NA" on EVERY row — never a pricing-simulation value and never a literal 0.
  { index: 73, name: "Total Loan Costs", source: "constant \"NA\" (INV-043)", notCollected: { code: "NA", justification: "§1003.4(a)(17)(i) reports the Closing Disclosure's §1026.38(f)(4) Loan Costs section D total; no covered loan is consummated (ASM-005), so no Closing Disclosure is ever issued and the amount does not exist. A pricing-simulation quote is not this data point — it is also computed on a different basis (it includes prepaids, which are Other Costs and are excluded from Total Loan Costs by definition)" } },
  { index: 74, name: "Total Points and Fees", source: "constant \"NA\" (INV-043)", notCollected: { code: "NA", justification: "§1003.4(a)(18) applies only to an originated covered loan; no loan is ever originated (ASM-005)" } },
  { index: 75, name: "Origination Charges", source: "constant \"NA\" (INV-043)", notCollected: { code: "NA", justification: "§1003.4(a)(19) reports the Closing Disclosure's §1026.38(f)(1) origination charges; no Closing Disclosure is ever issued (ASM-005)" } },
  { index: 76, name: "Discount Points", source: "constant \"NA\" (INV-043)", notCollected: { code: "NA", justification: "§1003.4(a)(20) reports the Closing Disclosure's §1026.38(f)(1) discount points; no Closing Disclosure is ever issued (ASM-005). NA, never a literal 0 — 0 would assert a disclosed amount of zero" } },
  { index: 77, name: "Lender Credits", source: "constant \"NA\" (INV-043)", notCollected: { code: "NA", justification: "§1003.4(a)(20) reports the Closing Disclosure's §1026.38(h)(3) lender credits; no Closing Disclosure is ever issued (ASM-005). NA, never a literal 0" } },
  { index: 78, name: "Interest Rate", source: "par scenario interestRate via simulatePricing (Q11) for approved-but-not-accepted records", notCollected: { code: "NA", justification: "denied/withdrawn records, or pricing inputs unavailable. NOT Closing-Disclosure-derived: §1003.4(a)(21) reports the rate applicable to the approval, which stays reportable for action taken 2" } },
  { index: 79, name: "Prepayment Penalty Term", source: "not collected", notCollected: { code: "NA", justification: "no prepayment-penalty product features exist" } },
  { index: 80, name: "Debt-to-Income Ratio", source: "stored Application.dti (shared task-010 module value, AC-13)", notCollected: { code: "NA", justification: "ratio never computed (missing inputs)" } },
  { index: 81, name: "Combined Loan-to-Value Ratio", source: "stored Application.cltv (shared task-010 module value, AC-13)", notCollected: { code: "NA", justification: "ratio never computed (missing inputs)" } },
  { index: 82, name: "Loan Term", source: "LoanDetails.loanTermMonths", notCollected: { code: "NA", justification: "term never saved" } },
  { index: 83, name: "Introductory Rate Period", source: "LoanDetails.armInitialFixedMonths when amortizationType = adjustable", notCollected: { code: "NA", justification: "fixed-rate loan (no introductory period)" } },
  { index: 84, name: "Balloon Payment", source: "constant \"2\"", notCollected: { code: "2", justification: "only fully amortizing fixed/ARM products exist" } },
  { index: 85, name: "Interest-Only Payments", source: "constant \"2\"", notCollected: { code: "2", justification: "only fully amortizing fixed/ARM products exist" } },
  { index: 86, name: "Negative Amortization", source: "constant \"2\"", notCollected: { code: "2", justification: "only fully amortizing fixed/ARM products exist" } },
  { index: 87, name: "Other Non-Amortizing Features", source: "constant \"2\"", notCollected: { code: "2", justification: "only fully amortizing fixed/ARM products exist" } },
  { index: 88, name: "Property Value", source: "the shared LTV denominator basis: avmValue when a non-stale completed AVM exists (ASM-006), else SubjectProperty.estimatedValue", notCollected: { code: "NA", justification: "no value saved" } },
  { index: 89, name: "Manufactured Home Secured Property Type", source: "SubjectProperty.manufacturedHomeLandInterest via HMDA_MANUFACTURED_HOME (VR-135): 1 (manufactured home AND land) only for a recorded direct-ownership or indirect-ownership land interest, 2 (manufactured home and not land) for any leasehold or uncaptured interest, 3 (NA) for site-built collateral", notCollected: { code: "2", justification: "manufactured home with no captured land interest — code 1 would assert that the security includes land on the strength of no recorded ownership interest, so the non-asserting code 2 is reported (see HMDA_MANUFACTURED_HOME_UNCAPTURED)" } },
  { index: 90, name: "Manufactured Home Land Property Interest", source: "SubjectProperty.manufacturedHomeLandInterest via HMDA_MANUFACTURED_HOME (VR-135): direct-ownership 1, indirect-ownership 2, paid-leasehold 3, unpaid-leasehold 4; site-built collateral reports 5", notCollected: { code: "3", justification: "code 5 is the FFIEC value for a loan NOT secured by a manufactured home, so it is legal only for site-built collateral (where field 89 = 3) and is never a not-collected code. A manufactured home with no captured interest reports the documented least-assertive legal pair 89 = 2 / 90 = 3 (paid leasehold). The pair (89 = 1, 90 = 5) is never emitted" } },
  { index: 91, name: "Total Units", source: "SubjectProperty.numberOfUnits, else derived from propertyType (two-unit 2 / three-unit 3 / four-unit 4), else 1" },
  { index: 92, name: "Multifamily Affordable Units", source: "not collected", notCollected: { code: "NA", justification: "no multifamily (5+ unit) properties exist in the product" } },
  { index: 93, name: "Submission of Application", source: "constant \"1\"", notCollected: { code: "1", justification: "every application is submitted directly through the borrower portal" } },
  // INV-043 (b): the never-originated premise does NOT reach this data point.
  // Reg C §1003.4(a)(34) extends it to APPLICATIONS — the obligation "would
  // have been" initially payable to the institution — and its not-applicable
  // code 3 is reserved for PURCHASED covered loans. This institution takes
  // every application through its own portal (field 93 = 1, submitted directly
  // to your institution) and purchases none, so 1 is the spec-mandated
  // affirmative value on every row; 3 would additionally contradict field 93.
  { index: 94, name: "Initially Payable to Your Institution", source: "constant \"1\" (§1003.4(a)(34) application extension — INV-043)" },
  { index: 95, name: "Mortgage Loan Originator NMLSR Identifier", source: "not collected", notCollected: { code: "NA", justification: "no NMLSR identifiers are captured for staff" } },
  { index: 96, name: "Automated Underwriting System 1", source: "5 (Other) when a completed AUS check exists, else 6 (NA)" },
  { index: 97, name: "Automated Underwriting System 2", source: "blank" },
  { index: 98, name: "Automated Underwriting System 3", source: "blank" },
  { index: 99, name: "Automated Underwriting System 4", source: "blank" },
  { index: 100, name: "Automated Underwriting System 5", source: "blank" },
  { index: 101, name: "Automated Underwriting System: Free Form Text", source: "constant \"Internal rule-based AUS simulation\" when AUS 1 = 5 (spec requires free-form for code 5)" },
  { index: 102, name: "AUS Result 1", source: "latest completed AUS recommendation via HMDA_AUS_RESULT, else 17 (NA)" },
  { index: 103, name: "AUS Result 2", source: "blank" },
  { index: 104, name: "AUS Result 3", source: "blank" },
  { index: 105, name: "AUS Result 4", source: "blank" },
  { index: 106, name: "AUS Result 5", source: "blank" },
  { index: 107, name: "AUS Result: Free Form Text", source: "blank" },
  { index: 108, name: "Reverse Mortgage", source: "constant \"2\"", notCollected: { code: "2", justification: "no reverse-mortgage product exists" } },
  { index: 109, name: "Open-End Line of Credit", source: "constant \"2\"", notCollected: { code: "2", justification: "no open-end credit product exists" } },
  { index: 110, name: "Business or Commercial Purpose", source: "constant \"2\"", notCollected: { code: "2", justification: "consumer-purpose residential mortgages only" } },
];

// ---------------------------------------------------------------------------
// Code tables (contracts.json enum literal -> HMDA code, verbatim keys)
// ---------------------------------------------------------------------------

/** LoanType -> HMDA Loan Type code. */
export const HMDA_LOAN_TYPE: Record<string, string> = {
  conventional: "1",
  fha: "2",
  va: "3",
  usda: "4",
};

/**
 * LoanPurpose -> HMDA Loan Purpose code. Documented interpretations:
 * construction and construction-to-permanent both report 1 (home purchase —
 * the HMDA treatment of construction-to-permanent; standalone construction is
 * folded in so every reportable application keeps a record). Missing -> 5 (NA).
 */
export const HMDA_LOAN_PURPOSE: Record<string, string> = {
  purchase: "1",
  "refinance-rate-term": "31",
  "refinance-cash-out": "32",
  construction: "1",
  "construction-to-permanent": "1",
};

/** OccupancyType -> HMDA Occupancy Type code. */
export const HMDA_OCCUPANCY: Record<string, string> = {
  "primary-residence": "1",
  "second-home": "2",
  "investment-property": "3",
};

/** EthnicityValue -> HMDA ethnicity code. */
export const HMDA_ETHNICITY: Record<string, string> = {
  "hispanic-or-latino": "1",
  mexican: "11",
  "puerto-rican": "12",
  cuban: "13",
  "other-hispanic-or-latino": "14",
  "not-hispanic-or-latino": "2",
  "not-provided": "3",
};

/** RaceValue -> HMDA race code. */
export const HMDA_RACE: Record<string, string> = {
  "american-indian-or-alaska-native": "1",
  asian: "2",
  "asian-indian": "21",
  chinese: "22",
  filipino: "23",
  japanese: "24",
  korean: "25",
  vietnamese: "26",
  "other-asian": "27",
  "black-or-african-american": "3",
  "native-hawaiian-or-pacific-islander": "4",
  "native-hawaiian": "41",
  "guamanian-or-chamorro": "42",
  samoan: "43",
  "other-pacific-islander": "44",
  white: "5",
  "not-provided": "6",
};

/** SexValue -> HMDA sex code. */
export const HMDA_SEX: Record<string, string> = {
  male: "1",
  female: "2",
  "not-provided": "3",
};

/** DenialReason enum -> HMDA Reason for Denial code (1:1 with the contract enum). */
export const HMDA_DENIAL_REASON: Record<string, string> = {
  dti: "1",
  "employment-history": "2",
  "credit-history": "3",
  collateral: "4",
  "insufficient-cash": "5",
  "unverifiable-information": "6",
  "application-incomplete": "7",
  "mortgage-insurance-denied": "8",
  other: "9",
};

/**
 * ASM-005 action-taken mapping (AC-50). Keys are the reportable
 * (workflowState[, outcome]) combinations; every other state is IN-FLIGHT and
 * EXCLUDED from the register. "File closed for incompleteness" (5) is unused —
 * no closure mechanism exists; "Loan originated" (1) is unused — loans are
 * never originated in-system, so a standing approval reports as 2.
 */
export const HMDA_ACTION_TAKEN = {
  /** approved / borrower_notified+approved / declined_by_borrower (ASM-005). */
  approvedButNotAccepted: "2",
  /** denied / borrower_notified+denied. */
  denied: "3",
  /** withdrawn. */
  withdrawn: "4",
} as const;

/**
 * AUS recommendation -> HMDA AUS Result code (field 102) for the internal
 * rule-based simulation. Keys are the contract's `AusRecommendation` enum —
 * the values an `aus` UnderwritingResult actually carries. No AUS run -> 17
 * (Not applicable), applied by the caller.
 *
 * HOLISTIC-REVIEW FIX: this table was previously keyed by `RecommendationValue`
 * ("approve" / "approve-with-conditions" / "deny") — the UNDERWRITER's
 * preliminary recommendation, a different contract enum whose value set is
 * disjoint from the AUS check's. Because the table was typed
 * `Record<string, string>`, the mismatched lookup typechecked cleanly, so every
 * row fell through to the `?? "17"` default while field 96 simultaneously
 * declared that an AUS system WAS used — an FFIEC validity-edit contradiction
 * that rejects the whole submission. The `Record<AusRecommendation, string>`
 * type below is load-bearing: it makes the same substitution a compile error.
 */
export const HMDA_AUS_RESULT: Record<AusRecommendation, string> = {
  "approve-eligible": "1", // Approve/Eligible
  refer: "3", // Refer
  "refer-with-caution": "5", // Refer with Caution
};

/** LAR fields 89 + 90, which are only ever valid as a PAIR. */
export interface ManufacturedHomeFields {
  /** Field 89 — Manufactured Home Secured Property Type. */
  securedPropertyType: string;
  /** Field 90 — Manufactured Home Land Property Interest. */
  landPropertyInterest: string;
}

/**
 * Site-built collateral (construction method 1). Field 90 code 5 is the FFIEC
 * value for "the loan is NOT secured by a manufactured home" — it is a
 * statement about the collateral, NOT a not-collected code, so this is the ONLY
 * combination in which it is legal.
 */
export const HMDA_NOT_MANUFACTURED_HOME: ManufacturedHomeFields = {
  securedPropertyType: "3", // Not applicable
  landPropertyInterest: "5", // Not applicable (not secured by a manufactured home)
};

/**
 * SubjectProperty.manufacturedHomeLandInterest -> LAR fields 89 + 90 (CH-011 /
 * VR-135), for construction method 2 (manufactured home).
 *
 * Field 89 code 1 ("Manufactured home and land") ASSERTS that the security
 * property includes the land, so it is emitted ONLY for a recorded direct or
 * indirect land OWNERSHIP interest. A leasehold interest is not ownership, so
 * the security is the home alone -> 89 = 2 ("Manufactured home and not land").
 *
 * "not-applicable" is a self-contradictory answer on a manufactured home — the
 * FFIEC reserves field 90 code 5 for collateral that is not a manufactured home
 * at all, and it is NOT a legal value when construction method is 2. It is
 * therefore folded into the same documented default as an absent value; see
 * HMDA_MANUFACTURED_HOME_UNCAPTURED.
 *
 * The `Record<ManufacturedHomeLandInterest, ...>` type is load-bearing (same
 * posture as HMDA_AUS_RESULT): it makes a drifted key set a compile error.
 */
export const HMDA_MANUFACTURED_HOME: Record<ManufacturedHomeLandInterest, ManufacturedHomeFields> = {
  "direct-ownership": { securedPropertyType: "1", landPropertyInterest: "1" },
  "indirect-ownership": { securedPropertyType: "1", landPropertyInterest: "2" },
  "paid-leasehold": { securedPropertyType: "2", landPropertyInterest: "3" },
  "unpaid-leasehold": { securedPropertyType: "2", landPropertyInterest: "4" },
  "not-applicable": { securedPropertyType: "2", landPropertyInterest: "3" },
};

/**
 * Documented default for a manufactured home whose land interest was never
 * captured (the field is optional — CH-011 landed after every existing
 * application was written, so every pre-existing row lacks it).
 *
 * 89 = 2 / 90 = 3 (Manufactured home and not land / Paid leasehold). The FFIEC
 * gives field 90 no "not collected" code and forbids code 5 when construction
 * method is 2, so SOME affirmative value must be reported. This pair is the
 * least-assertive legal one:
 *   - 89 = 2 refuses to assert that the security includes land, which is
 *     exactly the over-claim CH-011 exists to close; 89 = 1 would assert a
 *     recorded ownership interest that does not exist.
 *   - 90 = 3 (paid leasehold) is the modal arrangement for a manufactured home
 *     whose land is not part of the security — a land-lease community pad rent
 *     — and it is consistent with 89 = 2. 90 = 4 (unpaid leasehold) would
 *     instead assert a rent-free/gifted tenancy, a stronger and less likely
 *     claim; 90 = 1 or 2 would assert the ownership interest 89 = 2 denies.
 * The pair (89 = 1, 90 = 5) can never be produced by this table.
 */
export const HMDA_MANUFACTURED_HOME_UNCAPTURED: ManufacturedHomeFields =
  HMDA_MANUFACTURED_HOME["not-applicable"];

/** Codes for "no co-applicant" in the demographic field groups. */
export const NO_CO_APPLICANT = {
  ethnicity: "5",
  race: "8",
  sex: "5",
  visualObservation: "4",
  age: "9999",
  creditScore: "9999",
  creditScoreModel: "10",
} as const;
