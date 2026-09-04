# HMDA LAR Code Mapping — Complete (ASM-010)

This document contains the **complete 110-field HMDA Loan Application Register (LAR) field mapping** — the delivered conformance authority from the FFIEC 2018+ specification (unchanged through 2026 filing year), validated entry-by-entry by the test suite.

---

## Complete LAR Record Fields (110 Fields)

**Mapping Authority:** `src/lib/services/exports/hmda-lar-mapping.ts` — LAR_FIELDS array (transcribed faithfully)

| Index | Field Name | Source | NA Code | Justification |
|-------|-----------|--------|---------|----------------|
| 1 | Record Identifier | constant "2" | — | — |
| 2 | Legal Entity Identifier (LEI) | SystemConfig hmda.lei | — | — |
| 3 | Universal Loan Identifier (ULI) | LEI + applicationNumber (hyphens stripped) + ISO 7064 MOD 97-10 check digits | — | — |
| 4 | Application Date | Application.submittedAt as YYYYMMDD in America/New_York | NA | submittedAt null (never expected for reportable application) |
| 5 | Loan Type | LoanDetails.loanType via HMDA_LOAN_TYPE | — | — |
| 6 | Loan Purpose | LoanDetails.loanPurpose via HMDA_LOAN_PURPOSE | — | — |
| 7 | Preapproval | constant "2" | 2 | no preapproval-request program exists in the system |
| 8 | Construction Method | 2 when SubjectProperty.propertyType=manufactured-home OR manufacturedHome=true, else 1 | — | — |
| 9 | Occupancy Type | SubjectProperty.occupancy via HMDA_OCCUPANCY | 1 | occupancy absent → principal residence (URLA default; spec has no NA code) |
| 10 | Loan Amount | LoanDetails.requestedLoanAmount | NA | amount never saved on the application |
| 11 | Action Taken | workflowState/outcome via HMDA_ACTION_TAKEN (ASM-005) | — | — |
| 12 | Action Taken Date | decidedAt (decided) or stateEnteredAt (withdrawn/declined_by_borrower) as YYYYMMDD in America/New_York | — | — |
| 13 | Street Address | SubjectProperty.address.street (+ unit), pipe-sanitized | NA | address never saved |
| 14 | City | SubjectProperty.address.city, pipe-sanitized | NA | address never saved |
| 15 | State | SubjectProperty.address.state | NA | address never saved |
| 16 | Zip Code | SubjectProperty.address.zip | NA | address never saved |
| 17 | County | first 5 digits of SubjectProperty.geocode.censusTract (synthetic SSCCC FIPS) | NA | no stored geocode |
| 18 | Census Tract | SubjectProperty.geocode.censusTract with dots stripped (11 digits) | NA | no stored geocode |
| 19 | Ethnicity of Applicant 1 | borrower 1 Demographics.ethnicity[0] via HMDA_ETHNICITY | 3 | not provided / demographics never captured |
| 20 | Ethnicity of Applicant 2 | borrower 1 Demographics.ethnicity[1] | — | — |
| 21 | Ethnicity of Applicant 3 | borrower 1 Demographics.ethnicity[2] | — | — |
| 22 | Ethnicity of Applicant 4 | borrower 1 Demographics.ethnicity[3] | — | — |
| 23 | Ethnicity of Applicant 5 | borrower 1 Demographics.ethnicity[4] | — | — |
| 24 | Ethnicity of Applicant: Free Form Text for Other Hispanic or Latino | borrower 1 Demographics.ethnicityOtherDetail, pipe-sanitized | — | — |
| 25 | Ethnicity of Co-Applicant 1 | borrower 2 Demographics.ethnicity[0] | 5 | no co-applicant |
| 26 | Ethnicity of Co-Applicant 2 | borrower 2 Demographics.ethnicity[1] | — | — |
| 27 | Ethnicity of Co-Applicant 3 | borrower 2 Demographics.ethnicity[2] | — | — |
| 28 | Ethnicity of Co-Applicant 4 | borrower 2 Demographics.ethnicity[3] | — | — |
| 29 | Ethnicity of Co-Applicant 5 | borrower 2 Demographics.ethnicity[4] | — | — |
| 30 | Ethnicity of Co-Applicant: Free Form Text for Other Hispanic or Latino | borrower 2 Demographics.ethnicityOtherDetail, pipe-sanitized | — | — |
| 31 | Ethnicity of Applicant Collected on the Basis of Visual Observation or Surname | 2 when provided, 3 when not provided (DATA-003: electronic collection) | — | — |
| 32 | Ethnicity of Co-Applicant Collected on the Basis of Visual Observation or Surname | 2 provided / 3 not provided / 4 no co-applicant | — | — |
| 33 | Race of Applicant 1 | borrower 1 Demographics.race[0] via HMDA_RACE | 6 | not provided / demographics never captured |
| 34 | Race of Applicant 2 | borrower 1 Demographics.race[1] | — | — |
| 35 | Race of Applicant 3 | borrower 1 Demographics.race[2] | — | — |
| 36 | Race of Applicant 4 | borrower 1 Demographics.race[3] | — | — |
| 37 | Race of Applicant 5 | borrower 1 Demographics.race[4] | — | — |
| 38 | Race of Applicant: Free Form Text for American Indian or Alaska Native Enrolled or Principal Tribe | borrower 1 Demographics.raceOtherDetails assigned in order to selected free-form slots | — | — |
| 39 | Race of Applicant: Free Form Text for Other Asian | borrower 1 Demographics.raceOtherDetails (see field 38) | — | — |
| 40 | Race of Applicant: Free Form Text for Other Pacific Islander | borrower 1 Demographics.raceOtherDetails (see field 38) | — | — |
| 41 | Race of Co-Applicant 1 | borrower 2 Demographics.race[0] | 8 | no co-applicant |
| 42 | Race of Co-Applicant 2 | borrower 2 Demographics.race[1] | — | — |
| 43 | Race of Co-Applicant 3 | borrower 2 Demographics.race[2] | — | — |
| 44 | Race of Co-Applicant 4 | borrower 2 Demographics.race[3] | — | — |
| 45 | Race of Co-Applicant 5 | borrower 2 Demographics.race[4] | — | — |
| 46 | Race of Co-Applicant: Free Form Text for Tribe | borrower 2 Demographics.raceOtherDetails | — | — |
| 47 | Race of Co-Applicant: Free Form Text for Other Asian | borrower 2 Demographics.raceOtherDetails | — | — |
| 48 | Race of Co-Applicant: Free Form Text for Other Pacific Islander | borrower 2 Demographics.raceOtherDetails | — | — |
| 49 | Race of Applicant Collected on the Basis of Visual Observation or Surname | 2 provided / 3 not provided (DATA-003) | — | — |
| 50 | Race of Co-Applicant Collected on the Basis of Visual Observation or Surname | 2 provided / 3 not provided / 4 no co-applicant | — | — |
| 51 | Sex of Applicant | borrower 1 Demographics.sex via HMDA_SEX | 3 | not provided / demographics never captured |
| 52 | Sex of Co-Applicant | borrower 2 Demographics.sex | 5 | no co-applicant |
| 53 | Sex of Applicant Collected on the Basis of Visual Observation or Surname | 2 provided / 3 not provided (DATA-003) | — | — |
| 54 | Sex of Co-Applicant Collected on the Basis of Visual Observation or Surname | 2 provided / 3 not provided / 4 no co-applicant | — | — |
| 55 | Age of Applicant | borrower 1 decrypted DOB → whole years at Application.submittedAt (Feb-29 → Mar-1 in non-leap) | 8888 | DOB never captured |
| 56 | Age of Co-Applicant | borrower 2 age at application date | 9999 | no co-applicant (8888 when co-applicant DOB never captured) |
| 57 | Income | shared task-010 monthly income (monthlyIncomeCents × 12 ÷ 1000), rounded (thousands) | NA | no income rows saved (monthly income 0) |
| 58 | Type of Purchaser | constant "0" | 0 | loans never originated/sold in this system |
| 59 | Rate Spread | not derivable | NA | no APOR dataset to compute spread against |
| 60 | HOEPA Status | constant "3" | 3 | not applicable — loans never originated |
| 61 | Lien Status | constant "1" | 1 | every application is for first-lien mortgage (subordinate liens are CLTV inputs only) |
| 62 | Credit Score of Applicant | ASM-003 qualifying score (lower of borrowers' middle scores) from latest completed credit check | 8888 | no completed credit check |
| 63 | Credit Score of Co-Applicant | 9999 no co-applicant / 8888 otherwise | 8888 | one file-level qualifying score (ASM-003), no separate co-applicant score |
| 64 | Applicant Credit Score Model | 8 (Other) when score reported, 9 (NA) when 8888 | — | — |
| 65 | Applicant Credit Score Model: Free Form Text | constant "Simulated tri-bureau middle score" when model = 8 (spec requires free-form) | — | — |
| 66 | Co-Applicant Credit Score Model | 10 no co-applicant / 9 (NA) otherwise | — | — |
| 67 | Co-Applicant Credit Score Model: Free Form Text | blank | — | — |
| 68 | Reason for Denial 1 | deciding deny ApprovalRecord.denialReasons[0] via HMDA_DENIAL_REASON | 10 | not applicable — action taken is not a denial |
| 69 | Reason for Denial 2 | denialReasons[1] | — | — |
| 70 | Reason for Denial 3 | denialReasons[2] | — | — |
| 71 | Reason for Denial 4 | denialReasons[3] | — | — |
| 72 | Reason for Denial: Free Form Text | ApprovalRecord.denialReasonOtherText when reason is "other", pipe-sanitized | — | — |
| 73 | Total Loan Costs | constant "NA" (INV-043) | NA | §1003.4(a)(17)(i) reports the Closing Disclosure's §1026.38(f)(4) Loan Costs section D total; no covered loan is consummated (ASM-005), so no Closing Disclosure is ever issued. A pricing quote is not this data point (it also includes prepaids, which are Other Costs and excluded by definition) |
| 74 | Total Points and Fees | constant "NA" (INV-043) | NA | §1003.4(a)(18) applies only to an ORIGINATED covered loan; no loan is ever originated (ASM-005) |
| 75 | Origination Charges | constant "NA" (INV-043) | NA | §1003.4(a)(19) reports the Closing Disclosure's §1026.38(f)(1) origination charges; no Closing Disclosure is ever issued (ASM-005) |
| 76 | Discount Points | constant "NA" (INV-043) | NA | §1003.4(a)(20) reports the Closing Disclosure's §1026.38(f)(1) discount points; none is ever issued (ASM-005). NA, never a literal 0 |
| 77 | Lender Credits | constant "NA" (INV-043) | NA | §1003.4(a)(20) reports the Closing Disclosure's §1026.38(h)(3) lender credits; none is ever issued (ASM-005). NA, never a literal 0 |
| 78 | Interest Rate | par scenario interestRate via simulatePricing (Q11) for approved-but-not-accepted records | NA | denied/withdrawn/no-pricing-input records. NOT Closing-Disclosure-derived: §1003.4(a)(21) reports the rate applicable to the approval, so it stays reportable for action taken 2 |
| 79 | Prepayment Penalty Term | not collected | NA | no prepayment-penalty product features exist |
| 80 | Debt-to-Income Ratio | stored Application.dti (shared task-010 module value, AC-13) | NA | ratio never computed (missing inputs) |
| 81 | Combined Loan-to-Value Ratio | stored Application.cltv (shared task-010 module value, AC-13) | NA | ratio never computed (missing inputs) |
| 82 | Loan Term | LoanDetails.loanTermMonths | NA | term never saved |
| 83 | Introductory Rate Period | LoanDetails.armInitialFixedMonths when amortizationType = adjustable | NA | fixed-rate loan (no introductory period) |
| 84 | Balloon Payment | constant "2" | 2 | only fully amortizing fixed/ARM products exist |
| 85 | Interest-Only Payments | constant "2" | 2 | only fully amortizing fixed/ARM products exist |
| 86 | Negative Amortization | constant "2" | 2 | only fully amortizing fixed/ARM products exist |
| 87 | Other Non-Amortizing Features | constant "2" | 2 | only fully amortizing fixed/ARM products exist |
| 88 | Property Value | the shared LTV denominator basis: avmValue when non-stale AVM exists (ASM-006), else SubjectProperty.estimatedValue | NA | no value saved |
| 89 | Manufactured Home Secured Property Type | SubjectProperty.manufacturedHomeLandInterest via HMDA_MANUFACTURED_HOME (VR-135): 1 (home AND land) only for direct-ownership / indirect-ownership, 2 (home and not land) for any leasehold or uncaptured interest, 3 (NA) for site-built | 2 | manufactured home with no captured land interest — code 1 would assert the security includes land with no recorded ownership interest |
| 90 | Manufactured Home Land Property Interest | SubjectProperty.manufacturedHomeLandInterest via HMDA_MANUFACTURED_HOME (VR-135): direct-ownership 1, indirect-ownership 2, paid-leasehold 3, unpaid-leasehold 4; site-built reports 5 | 3 | code 5 means "not secured by a manufactured home" — legal ONLY for site-built collateral (field 89 = 3), never a not-collected code. Uncaptured manufactured rows report the least-assertive legal pair 89 = 2 / 90 = 3. The pair (89 = 1, 90 = 5) is never emitted |
| 91 | Total Units | SubjectProperty.numberOfUnits, else derived from propertyType (two-unit 2 / three-unit 3 / four-unit 4), else 1 | — | — |
| 92 | Multifamily Affordable Units | not collected | NA | no multifamily (5+ unit) properties exist in the product |
| 93 | Submission of Application | constant "1" | 1 | every application is submitted directly through borrower portal |
| 94 | Initially Payable to Your Institution | constant "1" (§1003.4(a)(34) application extension — INV-043) | — | §1003.4(a)(34) extends the data point to APPLICATIONS ("or, in the case of an application, would have been"), and code 3 is reserved for PURCHASED covered loans. Every application arrives through this institution's own portal (field 93 = 1), so 1 is affirmative and spec-mandated |
| 95 | Mortgage Loan Originator NMLSR Identifier | not collected | NA | no NMLSR identifiers captured for staff |
| 96 | Automated Underwriting System 1 | 5 (Other) when completed AUS check exists, else 6 (NA) | — | — |
| 97 | Automated Underwriting System 2 | blank | — | — |
| 98 | Automated Underwriting System 3 | blank | — | — |
| 99 | Automated Underwriting System 4 | blank | — | — |
| 100 | Automated Underwriting System 5 | blank | — | — |
| 101 | Automated Underwriting System: Free Form Text | constant "Internal rule-based AUS simulation" when AUS 1 = 5 (spec requires free-form) | — | — |
| 102 | AUS Result 1 | latest completed AUS recommendation via HMDA_AUS_RESULT, else 17 (NA) | — | — |
| 103 | AUS Result 2 | blank | — | — |
| 104 | AUS Result 3 | blank | — | — |
| 105 | AUS Result 4 | blank | — | — |
| 106 | AUS Result 5 | blank | — | — |
| 107 | AUS Result: Free Form Text | blank | — | — |
| 108 | Reverse Mortgage | constant "2" | 2 | no reverse-mortgage product exists |
| 109 | Open-End Line of Credit | constant "2" | 2 | no open-end credit product exists |
| 110 | Business or Commercial Purpose | constant "2" | 2 | consumer-purpose residential mortgages only |

---

## Transmittal Sheet (Header Record)

**Record ID:** 1 (first line of LAR file)

| Index | Field Name | Source | Value/Code | Justification |
|-------|-----------|--------|------------|----------------|
| 1 | Record Identifier | constant | 1 | — |
| 2 | Financial Institution Name | constant | MortMortgage | no institution-name SystemConfig key exists; product name is the documented constant |
| 3 | Calendar Year | Request parameter | ?year=YYYY | — |
| 4 | Calendar Quarter | constant | 4 | annual submission per FFIEC spec |
| 5 | Contact Person's Name | not collected | NA | no compliance-contact fields exist in system |
| 6 | Contact Person's Phone Number | not collected | NA | no compliance-contact fields exist |
| 7 | Contact Person's Email Address | not collected | NA | no compliance-contact fields exist |
| 8 | Contact Person's Office Street Address | not collected | NA | no compliance-contact fields exist |
| 9 | Contact Person's Office City | not collected | NA | no compliance-contact fields exist |
| 10 | Contact Person's Office State | not collected | NA | no compliance-contact fields exist |
| 11 | Contact Person's Office Zip Code | not collected | NA | no compliance-contact fields exist |
| 12 | Federal Agency | SystemConfig hmda.agencyCode | 409 (default) | — |
| 13 | Total Number of Entries | COUNT query | aggregate count | count of reportable applications for selected year |
| 14 | Federal Taxpayer Identification Number | not collected | NA | no TIN captured anywhere |
| 15 | Legal Entity Identifier (LEI) | SystemConfig hmda.lei | 409 (default) | — |

---

## Code Tables

### HMDA_LOAN_TYPE

| contracts.json Value | HMDA Code |
|---|---|
| conventional | 1 |
| fha | 2 |
| va | 3 |
| usda | 4 |

### HMDA_LOAN_PURPOSE

| contracts.json Value | HMDA Code | Notes |
|---|---|---|
| purchase | 1 | — |
| refinance-rate-term | 31 | — |
| refinance-cash-out | 32 | — |
| construction | 1 | construction-to-permanent also maps to 1 |
| construction-to-permanent | 1 | treated as home purchase per HMDA |

### HMDA_OCCUPANCY

| contracts.json Value | HMDA Code |
|---|---|
| primary-residence | 1 |
| second-home | 2 |
| investment-property | 3 |

### HMDA_ETHNICITY

| contracts.json Value | HMDA Code |
|---|---|
| hispanic-or-latino | 1 |
| mexican | 11 |
| puerto-rican | 12 |
| cuban | 13 |
| other-hispanic-or-latino | 14 |
| not-hispanic-or-latino | 2 |
| not-provided | 3 |

### HMDA_RACE

| contracts.json Value | HMDA Code |
|---|---|
| american-indian-or-alaska-native | 1 |
| asian | 2 |
| asian-indian | 21 |
| chinese | 22 |
| filipino | 23 |
| japanese | 24 |
| korean | 25 |
| vietnamese | 26 |
| other-asian | 27 |
| black-or-african-american | 3 |
| native-hawaiian-or-pacific-islander | 4 |
| native-hawaiian | 41 |
| guamanian-or-chamorro | 42 |
| samoan | 43 |
| other-pacific-islander | 44 |
| white | 5 |
| not-provided | 6 |

### HMDA_SEX

| contracts.json Value | HMDA Code |
|---|---|
| male | 1 |
| female | 2 |
| not-provided | 3 |

### HMDA_DENIAL_REASON

| contracts.json Value | HMDA Code |
|---|---|
| dti | 1 |
| employment-history | 2 |
| credit-history | 3 |
| collateral | 4 |
| insufficient-cash | 5 |
| unverifiable-information | 6 |
| application-incomplete | 7 |
| mortgage-insurance-denied | 8 |
| other | 9 |

### HMDA_ACTION_TAKEN (ASM-005)

| Scenario | HMDA Code | Notes |
|---|---|---|
| approved / borrower_notified (approved outcome) / declined_by_borrower | 2 | approved but not accepted; ASM-005 — loans never originated in-system, so code 1 is unused |
| denied / borrower_notified (denied outcome) | 3 | — |
| withdrawn | 4 | — |

**Reportability:** Only terminal states (approved, denied, withdrawn, declined_by_borrower) are included in LAR. In-flight states are excluded.

### HMDA_AUS_RESULT

Keyed by the `AusRecommendation` enum — the values an `aus` UnderwritingResult
actually carries. (Not `RecommendationValue`, which is the underwriter's own
preliminary recommendation and a different enum with a disjoint value set.)

| AUS Recommendation | HMDA Code | Notes |
|---|---|---|
| approve-eligible | 1 | Approve/Eligible |
| refer | 3 | Refer |
| refer-with-caution | 5 | Refer with Caution |
| (no AUS run) | 17 | Not applicable |

---

## Application-to-HMDA Transitions (ASM-005 Mapping)

| Application State | Outcome | Action Taken Code | Included in LAR? |
|---|---|---|---|
| Draft | (none) | — | NO |
| Application Received | (none) | — | NO |
| Completeness Validated | (none) | — | NO |
| Supporting Documents Received | (none) | — | NO |
| AUS Executed | (none) | — | NO |
| Preliminary Decision | (none) | — | NO |
| Escalated Review | (none) | — | NO |
| Conditional Approval | (none) | — | NO |
| Approved | approved | 2 | YES |
| Borrower Notified | approved | 2 | YES |
| Denied | denied | 3 | YES |
| Borrower Notified | denied | 3 | YES |
| Revision Requested | (any) | — | NO |
| Suspended | (any) | — | NO |
| Withdrawn | (any) | 4 | YES |
| Declined by Borrower | (any) | 2 | YES |

---

## Export & Filing

### Command

```bash
curl -X GET "https://mortmortgage.example.com/api/admin/exports/hmda-lar?year=2025" \
  -b "mm_session=<session_id>" \
  --output lar_2025.txt
```

### Prerequisites

- Supervisor role required
- SystemConfig `hmda.lei` and `hmda.agencyCode` must be set (409 error if not)
- Year parameter required (YYYY format)

### Output Format

Pipe-delimited text file (Unix LF line endings):

- **Line 1:** Transmittal sheet (record identifier 1, 15 fields)
- **Lines 2+:** Application records (record identifier 2, 110 fields each)
- One LAR record per reportable application (terminal states or outcomes only)

### Example

```
1|MortMortgage|2025|4|NA|NA|NA|NA|NA|NA|NA|409|247|NA|409
2|549300VBWWV6SL339J51|549300VBWWV6SL339J5198MM2025000001|20250315|1|1|2|1|1|350000|2|20250401|...
2|549300VBWWV6SL339J51|549300VBWWV6SL339J5198MM2025000002|20250320|2|3|2|1|3|275000|3|20250410|...
```

---

## Reference

**Authority:** `src/lib/services/exports/hmda-lar-mapping.ts` — LAR_FIELDS array (110 entries), lines 66–177; TS_FIELDS array (15 entries), lines 42–63

**Related:** `src/lib/services/exports/hmda-lar.ts` (LAR builder), code tables (HMDA_LOAN_TYPE, HMDA_ACTION_TAKEN, etc.)

**Spec:** FFIEC 2018+ pipe-delimited format (unchanged through 2026 filing year)

**Testing:** `task-042` (increment 12) evidence suite validates LAR export against this mapping
