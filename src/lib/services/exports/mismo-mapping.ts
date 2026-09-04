// URLA -> MISMO v3.4 field mapping — the delivered, machine-readable mapping
// artifact (ASM-010 / DATA-002 / REQ-073 / REQ-074, task-040).
//
// This table IS the conformance authority for the MISMO exports: automated
// evidence validates both the JSON and the XML export against it (every mapped
// URLA field's value must appear inside its declared MISMO container), and
// task-047 (increment 12) formats the human-readable delivery document from it.
//
// Path grammars
// -------------
// `source` — a dot path into ApplicationExportData (the shared masked loader in
//   ./application-export-data.ts). `[*]` on a segment means "every element of
//   the array"; multiple `[*]` segments flatten.
// `target` — a dot path into the MISMO logical document built by ./mismo.ts.
//   In the JSON export the path resolves through nested objects/arrays; in the
//   XML export each dot segment is a child element in the MISMO namespace and
//   `[*]` means repeated sibling elements. Keys beginning with "@" are XML
//   attributes (kept as same-named keys in JSON).
//
// Value semantics: unless `transform` is set, the export copies the source
// value verbatim (containment-checkable). Declared transforms:
//   - "date-only"           target carries the ISO date part (YYYY-MM-DD) of an
//                           ISO timestamp source.
//   - "construction-method" boolean manufacturedHome -> "Manufactured" | "SiteBuilt".
//   - "ssn-masked-or-full"  ***-**-NNNN by default; decrypted NNN-NN-NNNN only
//                           for `?full=true&reason=<text>` (Supervisor, audited).
//   - "dob-display-to-iso"  "Mon D, YYYY" display source -> ISO YYYY-MM-DD in
//                           the target, because the target is an xs:date
//                           element (INV-044 — MISMO exports only).
// Enum VALUES pass through as the contract's URLA value-set literals
// (contracts.json enums — §5.1); element/container NAMES are MISMO v3.4
// Reference Model names per this delivered mapping.

export interface MismoMappingEntry {
  /** URLA 2020 (Form 1003) section the field belongs to. */
  urlaSection: string;
  /** The URLA field, named by its contracts.json model + field path. */
  urlaField: string;
  /** Machine path into ApplicationExportData (see grammar above). */
  source: string;
  /** Machine path into the MISMO document (see grammar above). */
  target: string;
  /** Present when the value is transformed rather than copied verbatim. */
  transform?: "date-only" | "construction-method" | "ssn-masked-or-full" | "dob-display-to-iso";
  notes?: string;
}

/** MESSAGE > DEAL_SETS > DEAL_SET > DEALS > DEAL — the RFP §4.9.1 spine. */
export const DEAL = "MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL";
const PARTY = `${DEAL}.PARTIES.PARTY[*]`;
const BORROWER = `${PARTY}.ROLES.ROLE[*].BORROWER`;
const RESIDENCE = `${BORROWER}.RESIDENCES.RESIDENCE[*]`;
const EMPLOYER = `${BORROWER}.EMPLOYERS.EMPLOYER[*]`;
const DECLARATION = `${BORROWER}.DECLARATION.DECLARATION_DETAIL`;
const GOV = `${BORROWER}.GOVERNMENT_MONITORING`;
const LOAN = `${DEAL}.LOANS.LOAN[*]`;
const SUBJECT = `${DEAL}.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY`;
const ASSET = `${DEAL}.ASSETS.ASSET[*]`;
const REO = `${ASSET}.OWNED_PROPERTY`;
const LIABILITY = `${DEAL}.LIABILITIES.LIABILITY[*]`;

function entry(
  urlaSection: string,
  urlaField: string,
  source: string,
  target: string,
  transform?: MismoMappingEntry["transform"],
  notes?: string,
): MismoMappingEntry {
  const e: MismoMappingEntry = { urlaSection, urlaField, source, target };
  if (transform) e.transform = transform;
  if (notes) e.notes = notes;
  return e;
}

export const MISMO_MAPPING: readonly MismoMappingEntry[] = [
  // --- URLA 1a. Personal Information -> PARTIES > PARTY > INDIVIDUAL / BORROWER ---
  entry("1a Personal Information", "Borrower.firstName", "borrowers[*].firstName", `${PARTY}.INDIVIDUAL.NAME.FirstName`),
  entry("1a Personal Information", "Borrower.middleName", "borrowers[*].middleName", `${PARTY}.INDIVIDUAL.NAME.MiddleName`),
  entry("1a Personal Information", "Borrower.lastName", "borrowers[*].lastName", `${PARTY}.INDIVIDUAL.NAME.LastName`),
  entry("1a Personal Information", "Borrower.suffix", "borrowers[*].suffix", `${PARTY}.INDIVIDUAL.NAME.SuffixName`),
  entry("1a Personal Information", "Borrower.alternateNames", "borrowers[*].alternateNames[*]", `${PARTY}.INDIVIDUAL.NAME.AliasName[*]`),
  entry("1a Personal Information", "Borrower.ssn", "borrowers[*].ssnExportValue", `${PARTY}.TAXPAYER_IDENTIFIERS.TAXPAYER_IDENTIFIER[*].TaxpayerIdentifierValue`, "ssn-masked-or-full"),
  entry("1a Personal Information", "Borrower.dateOfBirth", "borrowers[*].dateOfBirthDisplay", `${BORROWER}.BORROWER_DETAIL.BorrowerBirthDate`, "dob-display-to-iso", 'INV-044: BorrowerBirthDate is an xs:date, so this element carries ISO YYYY-MM-DD — the single carve-out from the §A SEC-2 rule that raw ISO DOB never leaves the identity-own endpoint. The SOURCE is still the "Mon D, YYYY" display form (raw ISO is never plumbed into the export data); the MISMO serializer converts it locally. Every other API and UI surface continues to carry the display form.'),
  entry("1a Personal Information", "Borrower.citizenship", "borrowers[*].citizenship", `${BORROWER}.BORROWER_DETAIL.CitizenshipResidencyType`),
  entry("1a Personal Information", "Borrower.maritalStatus", "borrowers[*].maritalStatus", `${BORROWER}.BORROWER_DETAIL.MaritalStatusType`),
  entry("1a Personal Information", "Borrower.dependentsCount", "borrowers[*].dependentsCount", `${BORROWER}.BORROWER_DETAIL.DependentCount`),
  entry("1a Personal Information", "Borrower.dependentsAges", "borrowers[*].dependentsAges", `${BORROWER}.BORROWER_DETAIL.DependentAgesDescription`),
  entry("1a Personal Information", "Borrower.creditType", "borrowers[*].creditType", `${BORROWER}.BORROWER_DETAIL.JointAssetLiabilityReportingType`),
  entry("1a Personal Information", "Borrower.email", "borrowers[*].email", `${PARTY}.INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_EMAIL.ContactPointEmailValue`),
  entry("1a Personal Information", "Borrower.homePhone", "borrowers[*].homePhone", `${PARTY}.INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneValue`),
  entry("1a Personal Information", "Borrower.cellPhone", "borrowers[*].cellPhone", `${PARTY}.INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneValue`),
  entry("1a Personal Information", "Borrower.workPhone", "borrowers[*].workPhone", `${PARTY}.INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneValue`),
  entry("1a Personal Information", "Borrower.workPhoneExt", "borrowers[*].workPhoneExt", `${PARTY}.INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneExtensionValue`),
  entry("1a Personal Information", "MilitaryService.served", "borrowers[*].militaryService.served", `${BORROWER}.BORROWER_DETAIL.SelfDeclaredMilitaryServiceIndicator`),
  entry("1a Personal Information", "MilitaryService.status", "borrowers[*].militaryService.status", `${BORROWER}.BORROWER_DETAIL.MilitaryServiceStatusType`),
  entry("1a Personal Information", "MilitaryService.projectedExpirationDate", "borrowers[*].militaryService.projectedExpirationDate", `${BORROWER}.BORROWER_DETAIL.MilitaryServiceExpectedCompletionDate`),

  // --- URLA 1a. Current/Prior Address -> BORROWER > RESIDENCES > RESIDENCE ---
  entry("1a Address History", "Borrower.currentAddress.street", "borrowers[*].currentAddress.street", `${RESIDENCE}.ADDRESS.AddressLineText`),
  entry("1a Address History", "Borrower.currentAddress.unit", "borrowers[*].currentAddress.unit", `${RESIDENCE}.ADDRESS.AddressUnitIdentifier`),
  entry("1a Address History", "Borrower.currentAddress.city", "borrowers[*].currentAddress.city", `${RESIDENCE}.ADDRESS.CityName`),
  entry("1a Address History", "Borrower.currentAddress.state", "borrowers[*].currentAddress.state", `${RESIDENCE}.ADDRESS.StateCode`),
  entry("1a Address History", "Borrower.currentAddress.zip", "borrowers[*].currentAddress.zip", `${RESIDENCE}.ADDRESS.PostalCode`),
  entry("1a Address History", "Borrower.currentAddress.county", "borrowers[*].currentAddress.county", `${RESIDENCE}.ADDRESS.CountyName`),
  entry("1a Address History", "Borrower.housingStatus", "borrowers[*].housingStatus", `${RESIDENCE}.RESIDENCE_DETAIL.BorrowerResidencyBasisType`),
  entry("1a Address History", "Borrower.monthlyRent", "borrowers[*].monthlyRent", `${RESIDENCE}.RESIDENCE_DETAIL.ResidenceMonthlyRentAmount`),
  entry("1a Address History", "Borrower.yearsAtAddress", "borrowers[*].yearsAtAddress", `${RESIDENCE}.RESIDENCE_DETAIL.BorrowerResidencyDurationYearsCount`),
  entry("1a Address History", "Borrower.monthsAtAddress", "borrowers[*].monthsAtAddress", `${RESIDENCE}.RESIDENCE_DETAIL.BorrowerResidencyDurationMonthsCount`),
  entry("1a Address History", "PreviousAddress.address.street", "borrowers[*].previousAddresses[*].address.street", `${RESIDENCE}.ADDRESS.AddressLineText`),
  entry("1a Address History", "PreviousAddress.address.city", "borrowers[*].previousAddresses[*].address.city", `${RESIDENCE}.ADDRESS.CityName`),
  entry("1a Address History", "PreviousAddress.housingStatus", "borrowers[*].previousAddresses[*].housingStatus", `${RESIDENCE}.RESIDENCE_DETAIL.BorrowerResidencyBasisType`),
  entry("1a Address History", "PreviousAddress.yearsAtAddress", "borrowers[*].previousAddresses[*].yearsAtAddress", `${RESIDENCE}.RESIDENCE_DETAIL.BorrowerResidencyDurationYearsCount`),
  entry("1a Address History", "PreviousAddress.monthsAtAddress", "borrowers[*].previousAddresses[*].monthsAtAddress", `${RESIDENCE}.RESIDENCE_DETAIL.BorrowerResidencyDurationMonthsCount`),

  // --- URLA 1b-1e. Employment & Income -> BORROWER > EMPLOYERS > EMPLOYER ---
  entry("1b Current Employment", "EmploymentRecord.employerName", "borrowers[*].employments[*].employerName", `${EMPLOYER}.LEGAL_ENTITY.LEGAL_ENTITY_DETAIL.FullName`),
  entry("1b Current Employment", "EmploymentRecord.employerAddress.street", "borrowers[*].employments[*].employerAddress.street", `${EMPLOYER}.ADDRESS.AddressLineText`),
  entry("1b Current Employment", "EmploymentRecord.employerAddress.city", "borrowers[*].employments[*].employerAddress.city", `${EMPLOYER}.ADDRESS.CityName`),
  entry("1b Current Employment", "EmploymentRecord.employerPhone", "borrowers[*].employments[*].employerPhone", `${EMPLOYER}.EMPLOYMENT.EmployerTelephoneValue`),
  entry("1b Current Employment", "EmploymentRecord.position", "borrowers[*].employments[*].position", `${EMPLOYER}.EMPLOYMENT.EmploymentPositionDescription`),
  entry("1b Current Employment", "EmploymentRecord.startDate", "borrowers[*].employments[*].startDate", `${EMPLOYER}.EMPLOYMENT.EmploymentStartDate`),
  entry("1b Current Employment", "EmploymentRecord.yearsInLineOfWork", "borrowers[*].employments[*].yearsInLineOfWork", `${EMPLOYER}.EMPLOYMENT.EmploymentTimeInLineOfWorkYearsCount`),
  entry("1b Current Employment", "EmploymentRecord.selfEmployed", "borrowers[*].employments[*].selfEmployed", `${EMPLOYER}.EMPLOYMENT.EmploymentBorrowerSelfEmployedIndicator`),
  entry("1b Current Employment", "EmploymentRecord.employedByFamilyOrParty", "borrowers[*].employments[*].employedByFamilyOrParty", `${EMPLOYER}.EMPLOYMENT.SpecialBorrowerEmployerRelationshipIndicator`),
  entry("1b Current Employment", "EmploymentRecord.baseMonthlyIncome", "borrowers[*].employments[*].baseMonthlyIncome", `${EMPLOYER}.EMPLOYMENT.EmploymentBaseMonthlyIncomeAmount`),
  entry("1b Current Employment", "EmploymentRecord.overtime", "borrowers[*].employments[*].overtime", `${EMPLOYER}.EMPLOYMENT.EmploymentOvertimeMonthlyIncomeAmount`),
  entry("1b Current Employment", "EmploymentRecord.bonus", "borrowers[*].employments[*].bonus", `${EMPLOYER}.EMPLOYMENT.EmploymentBonusMonthlyIncomeAmount`),
  entry("1b Current Employment", "EmploymentRecord.commission", "borrowers[*].employments[*].commission", `${EMPLOYER}.EMPLOYMENT.EmploymentCommissionMonthlyIncomeAmount`),
  entry("1b Current Employment", "EmploymentRecord.militaryEntitlements", "borrowers[*].employments[*].militaryEntitlements", `${EMPLOYER}.EMPLOYMENT.EmploymentMilitaryEntitlementsMonthlyIncomeAmount`),
  entry("1b Current Employment", "EmploymentRecord.otherMonthlyIncome", "borrowers[*].employments[*].otherMonthlyIncome", `${EMPLOYER}.EMPLOYMENT.EmploymentOtherMonthlyIncomeAmount`),
  entry("1b Current Employment", "EmploymentRecord.selfEmployedMonthlyIncome", "borrowers[*].employments[*].selfEmployedMonthlyIncome", `${EMPLOYER}.EMPLOYMENT.EmploymentSelfEmployedMonthlyIncomeAmount`),
  entry("1d Previous Employment", "PreviousEmploymentRecord.employerName", "borrowers[*].previousEmployments[*].employerName", `${EMPLOYER}.LEGAL_ENTITY.LEGAL_ENTITY_DETAIL.FullName`),
  entry("1d Previous Employment", "PreviousEmploymentRecord.position", "borrowers[*].previousEmployments[*].position", `${EMPLOYER}.EMPLOYMENT.EmploymentPositionDescription`),
  entry("1d Previous Employment", "PreviousEmploymentRecord.startDate", "borrowers[*].previousEmployments[*].startDate", `${EMPLOYER}.EMPLOYMENT.EmploymentStartDate`),
  entry("1d Previous Employment", "PreviousEmploymentRecord.endDate", "borrowers[*].previousEmployments[*].endDate", `${EMPLOYER}.EMPLOYMENT.EmploymentEndDate`),
  entry("1d Previous Employment", "PreviousEmploymentRecord.previousGrossMonthlyIncome", "borrowers[*].previousEmployments[*].previousGrossMonthlyIncome", `${EMPLOYER}.EMPLOYMENT.EmploymentPreviousGrossMonthlyIncomeAmount`),
  entry("1e Other Income", "OtherIncomeRecord.source", "borrowers[*].otherIncome[*].source", `${BORROWER}.CURRENT_INCOME.CURRENT_INCOME_ITEMS.CURRENT_INCOME_ITEM[*].CURRENT_INCOME_ITEM_DETAIL.IncomeType`),
  entry("1e Other Income", "OtherIncomeRecord.monthlyAmount", "borrowers[*].otherIncome[*].monthlyAmount", `${BORROWER}.CURRENT_INCOME.CURRENT_INCOME_ITEMS.CURRENT_INCOME_ITEM[*].CURRENT_INCOME_ITEM_DETAIL.CurrentIncomeMonthlyTotalAmount`),

  // --- URLA 5. Declarations -> BORROWER > DECLARATION > DECLARATION_DETAIL ---
  entry("5a Declarations", "Declarations.aOccupyPrimary", "borrowers[*].declarations.aOccupyPrimary", `${DECLARATION}.IntentToOccupyPropertyAsPrimaryResidenceIndicator`),
  entry("5a Declarations", "Declarations.a1PriorOwnership", "borrowers[*].declarations.a1PriorOwnership", `${DECLARATION}.HomeownerPastThreeYearsIndicator`),
  entry("5a Declarations", "Declarations.a1PropertyType", "borrowers[*].declarations.a1PropertyType", `${DECLARATION}.PriorPropertyUsageType`),
  entry("5a Declarations", "Declarations.a1TitleHeld", "borrowers[*].declarations.a1TitleHeld", `${DECLARATION}.PriorPropertyTitleType`),
  entry("5a Declarations", "Declarations.bSellerRelationship", "borrowers[*].declarations.bSellerRelationship", `${DECLARATION}.SpecialBorrowerSellerRelationshipIndicator`),
  entry("5a Declarations", "Declarations.cUndisclosedBorrowing", "borrowers[*].declarations.cUndisclosedBorrowing", `${DECLARATION}.UndisclosedBorrowedFundsIndicator`),
  entry("5a Declarations", "Declarations.cAmount", "borrowers[*].declarations.cAmount", `${DECLARATION}.UndisclosedBorrowedFundsAmount`),
  entry("5a Declarations", "Declarations.d1OtherMortgageApplication", "borrowers[*].declarations.d1OtherMortgageApplication", `${DECLARATION}.UndisclosedMortgageApplicationIndicator`),
  entry("5a Declarations", "Declarations.d2NewCreditApplication", "borrowers[*].declarations.d2NewCreditApplication", `${DECLARATION}.UndisclosedCreditApplicationIndicator`),
  entry("5a Declarations", "Declarations.ePriorityLien", "borrowers[*].declarations.ePriorityLien", `${DECLARATION}.PropertyProposedCleanEnergyLienIndicator`),
  entry("5b Declarations", "Declarations.fCosignerUndisclosed", "borrowers[*].declarations.fCosignerUndisclosed", `${DECLARATION}.UndisclosedComakerOfNoteIndicator`),
  entry("5b Declarations", "Declarations.gOutstandingJudgments", "borrowers[*].declarations.gOutstandingJudgments", `${DECLARATION}.OutstandingJudgmentsIndicator`),
  entry("5b Declarations", "Declarations.hFederalDebtDelinquent", "borrowers[*].declarations.hFederalDebtDelinquent", `${DECLARATION}.PresentlyDelinquentIndicator`),
  entry("5b Declarations", "Declarations.iPartyToLawsuit", "borrowers[*].declarations.iPartyToLawsuit", `${DECLARATION}.PartyToLawsuitIndicator`),
  entry("5b Declarations", "Declarations.jConveyedTitleInLieu", "borrowers[*].declarations.jConveyedTitleInLieu", `${DECLARATION}.PriorPropertyDeedInLieuConveyedIndicator`),
  entry("5b Declarations", "Declarations.kPreForeclosureSale", "borrowers[*].declarations.kPreForeclosureSale", `${DECLARATION}.PriorPropertyShortSaleCompletedIndicator`),
  entry("5b Declarations", "Declarations.lForeclosed", "borrowers[*].declarations.lForeclosed", `${DECLARATION}.PriorPropertyForeclosureCompletedIndicator`),
  entry("5b Declarations", "Declarations.mBankruptcy", "borrowers[*].declarations.mBankruptcy", `${DECLARATION}.BankruptcyIndicator`),
  entry("5b Declarations", "Declarations.mBankruptcyType", "borrowers[*].declarations.mBankruptcyType", `${DECLARATION}.BankruptcyChapterType`),

  // --- URLA 8. Demographics -> BORROWER > GOVERNMENT_MONITORING ---
  entry("8 Demographic Information", "Demographics.ethnicity", "borrowers[*].demographics.ethnicity[*]", `${GOV}.HMDA_ETHNICITIES.HMDA_ETHNICITY[*].HMDAEthnicityType`),
  entry("8 Demographic Information", "Demographics.ethnicityOtherDetail", "borrowers[*].demographics.ethnicityOtherDetail", `${GOV}.GOVERNMENT_MONITORING_DETAIL.HMDAEthnicityOtherHispanicOrLatinoOriginDescription`),
  entry("8 Demographic Information", "Demographics.race", "borrowers[*].demographics.race[*]", `${GOV}.HMDA_RACES.HMDA_RACE[*].HMDARaceType`),
  entry("8 Demographic Information", "Demographics.raceOtherDetails", "borrowers[*].demographics.raceOtherDetails[*]", `${GOV}.GOVERNMENT_MONITORING_DETAIL.HMDARaceOtherDescription[*]`),
  entry("8 Demographic Information", "Demographics.sex", "borrowers[*].demographics.sex", `${GOV}.GOVERNMENT_MONITORING_DETAIL.HMDAGenderType`),
  entry("8 Demographic Information", "Demographics.collectionMethod", "borrowers[*].demographics.collectionMethod", `${GOV}.GOVERNMENT_MONITORING_DETAIL.ApplicationTakenMethodType`),
  entry("8 Demographic Information", "Demographics.visualObservation", "borrowers[*].demographics.visualObservation", `${GOV}.GOVERNMENT_MONITORING_DETAIL.HMDAEthnicityCollectedBasedOnVisualObservationOrSurnameIndicator`),

  // --- URLA 4a/L. Loan -> LOANS > LOAN (TERMS_OF_LOAN / LOAN_DETAIL / AMORTIZATION / QUALIFICATION) ---
  entry("Lender Loan Information", "Application.applicationNumber", "application.applicationNumber", `${LOAN}.LOAN_IDENTIFIERS.LOAN_IDENTIFIER[*].LoanIdentifier`),
  entry("Lender Loan Information", "Application.submittedAt", "application.submittedAt", `${LOAN}.LOAN_DETAIL.ApplicationReceivedDate`, "date-only"),
  entry("4a Loan Information", "LoanDetails.loanType", "data.loan.loanType", `${LOAN}.TERMS_OF_LOAN.MortgageType`),
  entry("4a Loan Information", "LoanDetails.loanPurpose", "data.loan.loanPurpose", `${LOAN}.TERMS_OF_LOAN.LoanPurposeType`),
  entry("4a Loan Information", "LoanDetails.requestedLoanAmount", "data.loan.requestedLoanAmount", `${LOAN}.TERMS_OF_LOAN.BaseLoanAmount`),
  entry("4a Loan Information", "LoanDetails.downPaymentAmount", "data.loan.downPaymentAmount", `${LOAN}.TERMS_OF_LOAN.DownPaymentAmount`),
  entry("4a Loan Information", "LoanDetails.downPaymentSource", "data.loan.downPaymentSource", `${LOAN}.TERMS_OF_LOAN.DownPaymentSourceType`),
  entry("4a Loan Information", "LoanDetails.amortizationType", "data.loan.amortizationType", `${LOAN}.AMORTIZATION.AMORTIZATION_RULE.AmortizationType`),
  entry("4a Loan Information", "LoanDetails.loanTermMonths", "data.loan.loanTermMonths", `${LOAN}.AMORTIZATION.AMORTIZATION_RULE.LoanAmortizationPeriodCount`),
  entry("4a Loan Information", "LoanDetails.armInitialFixedMonths", "data.loan.armInitialFixedMonths", `${LOAN}.AMORTIZATION.ARM.InitialFixedPeriodMonthsCount`),
  entry("4a Loan Information", "LoanDetails.armAdjustmentMonths", "data.loan.armAdjustmentMonths", `${LOAN}.AMORTIZATION.ARM.AdjustmentPeriodMonthsCount`),
  entry("4b Other New Mortgage Loans", "OtherNewMortgage.creditor", "data.loan.otherNewMortgages[*].creditor", `${LOAN}.OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].CreditorName`),
  entry("4b Other New Mortgage Loans", "OtherNewMortgage.lienType", "data.loan.otherNewMortgages[*].lienType", `${LOAN}.OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].LienPriorityType`),
  entry("4b Other New Mortgage Loans", "OtherNewMortgage.monthlyPayment", "data.loan.otherNewMortgages[*].monthlyPayment", `${LOAN}.OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].MonthlyPaymentAmount`),
  entry("4b Other New Mortgage Loans", "OtherNewMortgage.amount", "data.loan.otherNewMortgages[*].amount", `${LOAN}.OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].LoanAmount`),
  entry("4b Other New Mortgage Loans", "OtherNewMortgage.creditLimit", "data.loan.otherNewMortgages[*].creditLimit", `${LOAN}.OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].CreditLimitAmount`),
  entry("Refinance", "RefinanceDetails.originalCost", "data.loan.refinance.originalCost", `${LOAN}.REFINANCE.RefinanceOriginalCostAmount`),
  entry("Refinance", "RefinanceDetails.existingLiens", "data.loan.refinance.existingLiens", `${LOAN}.REFINANCE.RefinanceExistingLienAmount`),
  entry("Refinance", "RefinanceDetails.purposeOfRefinance", "data.loan.refinance.purposeOfRefinance", `${LOAN}.REFINANCE.RefinancePrimaryPurposeType`),
  entry("Refinance", "RefinanceDetails.improvementsDescription", "data.loan.refinance.improvementsDescription", `${LOAN}.REFINANCE.RefinanceImprovementsDescription`),
  entry("Refinance", "RefinanceDetails.improvementsCost", "data.loan.refinance.improvementsCost", `${LOAN}.REFINANCE.RefinanceImprovementCostsAmount`),
  entry("Qualification", "Application.dti", "application.dti", `${LOAN}.QUALIFICATION.TotalDebtExpenseRatioPercent`, undefined, "Stored task-010 shared-module value (AC-13)"),
  entry("Qualification", "Application.ltv", "application.ltv", `${LOAN}.QUALIFICATION.LTVRatioPercent`, undefined, "Stored task-010 shared-module value (AC-13)"),
  entry("Qualification", "Application.cltv", "application.cltv", `${LOAN}.QUALIFICATION.CombinedLTVRatioPercent`, undefined, "Stored task-010 shared-module value (AC-13)"),
  entry("Qualification", "CreditCheckResult.qualifyingScore", "creditQualifyingScore", `${LOAN}.QUALIFICATION.QualifyingCreditScoreValue`, undefined, "ASM-003 lower-middle score from the latest completed credit check, when one exists"),
  entry("Proposed Housing Expense", "ProposedHousingExpense.firstMortgagePi", "data.proposedHousingExpense.firstMortgagePi", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged HousingExpenseType "FirstMortgagePrincipalAndInterest"'),
  entry("Proposed Housing Expense", "ProposedHousingExpense.subordinateLiens", "data.proposedHousingExpense.subordinateLiens", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged "SubordinateLienPayment"'),
  entry("Proposed Housing Expense", "ProposedHousingExpense.homeownersInsurance", "data.proposedHousingExpense.homeownersInsurance", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged "HomeownersInsurance"'),
  entry("Proposed Housing Expense", "ProposedHousingExpense.supplementalInsurance", "data.proposedHousingExpense.supplementalInsurance", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged "SupplementalPropertyInsurance"'),
  entry("Proposed Housing Expense", "ProposedHousingExpense.propertyTaxes", "data.proposedHousingExpense.propertyTaxes", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged "RealEstateTax"'),
  entry("Proposed Housing Expense", "ProposedHousingExpense.mortgageInsurance", "data.proposedHousingExpense.mortgageInsurance", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged "MortgageInsurance"'),
  entry("Proposed Housing Expense", "ProposedHousingExpense.hoaDues", "data.proposedHousingExpense.hoaDues", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged "HomeownersAssociationDues"'),
  entry("Proposed Housing Expense", "ProposedHousingExpense.other", "data.proposedHousingExpense.other", `${LOAN}.HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount`, undefined, 'Row tagged "Other"'),

  // --- URLA 4c. Gifts/Grants + Other Credits -> LOAN > PURCHASE_CREDITS ---
  entry("4c-4d Other Credits", "OtherCreditRecord.type", "data.otherCredits[*].type", `${LOAN}.PURCHASE_CREDITS.PURCHASE_CREDIT[*].PurchaseCreditType`),
  entry("4c-4d Other Credits", "OtherCreditRecord.sourceOrDonor", "data.otherCredits[*].sourceOrDonor", `${LOAN}.PURCHASE_CREDITS.PURCHASE_CREDIT[*].PurchaseCreditSourceDescription`),
  entry("4c-4d Other Credits", "OtherCreditRecord.value", "data.otherCredits[*].value", `${LOAN}.PURCHASE_CREDITS.PURCHASE_CREDIT[*].PurchaseCreditAmount`),

  // --- URLA 4a/4b Property -> COLLATERALS > COLLATERAL > SUBJECT_PROPERTY ---
  entry("4a Property Information", "SubjectProperty.address.street", "data.subjectProperty.address.street", `${SUBJECT}.ADDRESS.AddressLineText`),
  entry("4a Property Information", "SubjectProperty.address.unit", "data.subjectProperty.address.unit", `${SUBJECT}.ADDRESS.AddressUnitIdentifier`),
  entry("4a Property Information", "SubjectProperty.address.city", "data.subjectProperty.address.city", `${SUBJECT}.ADDRESS.CityName`),
  entry("4a Property Information", "SubjectProperty.address.state", "data.subjectProperty.address.state", `${SUBJECT}.ADDRESS.StateCode`),
  entry("4a Property Information", "SubjectProperty.address.zip", "data.subjectProperty.address.zip", `${SUBJECT}.ADDRESS.PostalCode`),
  entry("4a Property Information", "SubjectProperty.address.county", "data.subjectProperty.address.county", `${SUBJECT}.ADDRESS.CountyName`),
  entry("4a Property Information", "SubjectProperty.numberOfUnits", "data.subjectProperty.numberOfUnits", `${SUBJECT}.PROPERTY_DETAIL.FinancedUnitCount`),
  entry("4a Property Information", "SubjectProperty.propertyType", "data.subjectProperty.propertyType", `${SUBJECT}.PROPERTY_DETAIL.PropertyType`),
  entry("4a Property Information", "SubjectProperty.occupancy", "data.subjectProperty.occupancy", `${SUBJECT}.PROPERTY_DETAIL.PropertyUsageType`),
  entry("4a Property Information", "SubjectProperty.mixedUse", "data.subjectProperty.mixedUse", `${SUBJECT}.PROPERTY_DETAIL.PropertyMixedUsageIndicator`),
  entry("4a Property Information", "SubjectProperty.manufacturedHome", "data.subjectProperty.manufacturedHome", `${SUBJECT}.PROPERTY_DETAIL.ConstructionMethodType`, "construction-method"),
  entry("4a Property Information", "SubjectProperty.estimatedValue", "data.subjectProperty.estimatedValue", `${SUBJECT}.PROPERTY_DETAIL.PropertyEstimatedValueAmount`),
  entry("4a Property Information", "SubjectProperty.expectedMonthlyRentalIncome", "data.subjectProperty.expectedMonthlyRentalIncome", `${SUBJECT}.PROPERTY_DETAIL.PropertyExpectedMonthlyRentalIncomeAmount`),
  entry("Title Information", "SubjectProperty.titleNames", "data.subjectProperty.titleNames", `${SUBJECT}.PROPERTY_DETAIL.PropertyTitleNamesDescription`),
  entry("Title Information", "SubjectProperty.titleManner", "data.subjectProperty.titleManner", `${SUBJECT}.PROPERTY_DETAIL.TitleMannerHeldType`),
  entry("Title Information", "SubjectProperty.estate", "data.subjectProperty.estate", `${SUBJECT}.PROPERTY_DETAIL.PropertyEstateType`),
  entry("Title Information", "SubjectProperty.leaseholdExpirationDate", "data.subjectProperty.leaseholdExpirationDate", `${SUBJECT}.PROPERTY_DETAIL.LeaseholdExpirationDate`),
  entry("4a Property Information", "SubjectProperty.targetClosingDate", "data.subjectProperty.targetClosingDate", `${SUBJECT}.PROPERTY_DETAIL.TargetClosingDate`),
  entry("4a Property Information", "SubjectProperty.estimatedValue (valuation)", "data.subjectProperty.estimatedValue", `${SUBJECT}.PROPERTY_VALUATIONS.PROPERTY_VALUATION[*].PROPERTY_VALUATION_DETAIL.PropertyValuationAmount`, undefined, 'Borrower stated value; an "AutomatedValuationModel" valuation row is added when a current (non-stale) AVM result exists (ASM-006)'),

  // --- URLA 2a. Assets -> ASSETS > ASSET ---
  entry("2a Assets", "AssetRecord.accountType", "data.assets[*].accountType", `${ASSET}.ASSET_DETAIL.AssetType`),
  entry("2a Assets", "AssetRecord.financialInstitution", "data.assets[*].financialInstitution", `${ASSET}.ASSET_HOLDER.NAME.FullName`),
  entry("2a Assets", "AssetRecord.accountNumberLast4", "data.assets[*].accountNumberLast4", `${ASSET}.ASSET_DETAIL.AssetAccountIdentifier`, undefined, "Last four only — account-number ciphertext never leaves the system"),
  entry("2a Assets", "AssetRecord.cashOrMarketValue", "data.assets[*].cashOrMarketValue", `${ASSET}.ASSET_DETAIL.AssetCashOrMarketValueAmount`),
  entry("2a Assets", "AssetRecord.source", "data.assets[*].source", `${ASSET}.ASSET_DETAIL.FundsSourceType`),

  // --- URLA 3. Real Estate Owned -> ASSETS > ASSET > OWNED_PROPERTY ---
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.address.street", "data.realEstateOwned[*].address.street", `${REO}.PROPERTY.ADDRESS.AddressLineText`),
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.address.city", "data.realEstateOwned[*].address.city", `${REO}.PROPERTY.ADDRESS.CityName`),
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.propertyValue", "data.realEstateOwned[*].propertyValue", `${REO}.PROPERTY.PropertyEstimatedValueAmount`),
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.status", "data.realEstateOwned[*].status", `${REO}.OWNED_PROPERTY_DETAIL.OwnedPropertyDispositionStatusType`),
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.intendedOccupancy", "data.realEstateOwned[*].intendedOccupancy", `${REO}.OWNED_PROPERTY_DETAIL.OwnedPropertyIntendedUsageType`),
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.monthlyInsuranceTaxesHoa", "data.realEstateOwned[*].monthlyInsuranceTaxesHoa", `${REO}.OWNED_PROPERTY_DETAIL.OwnedPropertyMaintenanceExpenseAmount`),
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.monthlyRentalIncome", "data.realEstateOwned[*].monthlyRentalIncome", `${REO}.OWNED_PROPERTY_DETAIL.OwnedPropertyRentalIncomeGrossAmount`),
  entry("3 Real Estate Owned", "RealEstateOwnedRecord.netMonthlyRentalIncome", "data.realEstateOwned[*].netMonthlyRentalIncome", `${REO}.OWNED_PROPERTY_DETAIL.OwnedPropertyRentalIncomeNetAmount`),
  entry("3 Real Estate Owned", "ReoMortgage.creditor", "data.realEstateOwned[*].mortgages[*].creditor", `${REO}.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].CreditorName`),
  entry("3 Real Estate Owned", "ReoMortgage.accountNumberLast4", "data.realEstateOwned[*].mortgages[*].accountNumberLast4", `${REO}.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].LiabilityAccountIdentifier`),
  entry("3 Real Estate Owned", "ReoMortgage.monthlyPayment", "data.realEstateOwned[*].mortgages[*].monthlyPayment", `${REO}.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].MonthlyPaymentAmount`),
  entry("3 Real Estate Owned", "ReoMortgage.unpaidBalance", "data.realEstateOwned[*].mortgages[*].unpaidBalance", `${REO}.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].UnpaidBalanceAmount`),
  entry("3 Real Estate Owned", "ReoMortgage.paidOffAtClosing", "data.realEstateOwned[*].mortgages[*].paidOffAtClosing", `${REO}.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].PayoffAtClosingIndicator`),
  entry("3 Real Estate Owned", "ReoMortgage.mortgageType", "data.realEstateOwned[*].mortgages[*].mortgageType", `${REO}.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].MortgageType`),

  // --- URLA 2b/2c. Liabilities -> LIABILITIES > LIABILITY ---
  entry("2b Liabilities", "LiabilityRecord.accountType", "data.liabilities[*].accountType", `${LIABILITY}.LIABILITY_DETAIL.LiabilityType`),
  entry("2b Liabilities", "LiabilityRecord.companyName", "data.liabilities[*].companyName", `${LIABILITY}.LIABILITY_HOLDER.NAME.FullName`),
  entry("2b Liabilities", "LiabilityRecord.accountNumberLast4", "data.liabilities[*].accountNumberLast4", `${LIABILITY}.LIABILITY_DETAIL.LiabilityAccountIdentifier`, undefined, "Last four only"),
  entry("2b Liabilities", "LiabilityRecord.unpaidBalance", "data.liabilities[*].unpaidBalance", `${LIABILITY}.LIABILITY_DETAIL.LiabilityUnpaidBalanceAmount`),
  entry("2b Liabilities", "LiabilityRecord.monthlyPayment", "data.liabilities[*].monthlyPayment", `${LIABILITY}.LIABILITY_DETAIL.LiabilityMonthlyPaymentAmount`),
  entry("2b Liabilities", "LiabilityRecord.monthsLeft", "data.liabilities[*].monthsLeft", `${LIABILITY}.LIABILITY_DETAIL.LiabilityRemainingTermMonthsCount`),
  entry("2b Liabilities", "LiabilityRecord.paidOffAtClosing", "data.liabilities[*].paidOffAtClosing", `${LIABILITY}.LIABILITY_DETAIL.LiabilityPayoffStatusIndicator`),
  entry("2c Other Liabilities", "OtherLiabilityRecord.type", "data.otherLiabilities[*].type", `${LIABILITY}.LIABILITY_DETAIL.LiabilityType`),
  entry("2c Other Liabilities", "OtherLiabilityRecord.monthlyPayment", "data.otherLiabilities[*].monthlyPayment", `${LIABILITY}.LIABILITY_DETAIL.LiabilityMonthlyPaymentAmount`),
] as const;
