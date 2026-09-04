# URLA to MISMO v3.4 Field Mapping — Complete (ASM-010)

This document contains the **complete 167-entry URLA 2020 to MISMO v3.4 field mapping** — the delivered conformance authority validated entry-by-entry by the test suite. Every mapped URLA field's value must appear in its declared MISMO container.

---

## Complete URLA-MISMO Mapping Table (167 Entries)

**Mapping Authority:** `src/lib/services/exports/mismo-mapping.ts` (transcribed faithfully)

| # | URLA Section | URLA Field | Source Path | Target Path | Transform | Notes |
|---|---|---|---|---|---|---|
| 1 | 1a Personal Information | Borrower.firstName | borrowers[*].firstName | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.NAME.FirstName | — | — |
| 2 | 1a Personal Information | Borrower.middleName | borrowers[*].middleName | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.NAME.MiddleName | — | — |
| 3 | 1a Personal Information | Borrower.lastName | borrowers[*].lastName | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.NAME.LastName | — | — |
| 4 | 1a Personal Information | Borrower.suffix | borrowers[*].suffix | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.NAME.SuffixName | — | — |
| 5 | 1a Personal Information | Borrower.alternateNames | borrowers[*].alternateNames[*] | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.NAME.AliasName[*] | — | — |
| 6 | 1a Personal Information | Borrower.ssn | borrowers[*].ssnExportValue | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].TAXPAYER_IDENTIFIERS.TAXPAYER_IDENTIFIER[*].TaxpayerIdentifierValue | ssn-masked-or-full | — |
| 7 | 1a Personal Information | Borrower.dateOfBirth | borrowers[*].dateOfBirthDisplay | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.BorrowerBirthDate | dob-display-to-iso | INV-044: BorrowerBirthDate is an xs:date, so this element carries ISO YYYY-MM-DD — the single carve-out from the SEC-2 rule that raw ISO DOB never leaves the identity-own endpoint. Source stays the "Mon D, YYYY" display form; the MISMO serializer converts locally. Every other API/UI surface keeps the display form |
| 8 | 1a Personal Information | Borrower.citizenship | borrowers[*].citizenship | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.CitizenshipResidencyType | — | — |
| 9 | 1a Personal Information | Borrower.maritalStatus | borrowers[*].maritalStatus | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.MaritalStatusType | — | — |
| 10 | 1a Personal Information | Borrower.dependentsCount | borrowers[*].dependentsCount | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.DependentCount | — | — |
| 11 | 1a Personal Information | Borrower.dependentsAges | borrowers[*].dependentsAges | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.DependentAgesDescription | — | — |
| 12 | 1a Personal Information | Borrower.creditType | borrowers[*].creditType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.JointAssetLiabilityReportingType | — | — |
| 13 | 1a Personal Information | Borrower.email | borrowers[*].email | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_EMAIL.ContactPointEmailValue | — | — |
| 14 | 1a Personal Information | Borrower.homePhone | borrowers[*].homePhone | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneValue | — | — |
| 15 | 1a Personal Information | Borrower.cellPhone | borrowers[*].cellPhone | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneValue | — | — |
| 16 | 1a Personal Information | Borrower.workPhone | borrowers[*].workPhone | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneValue | — | — |
| 17 | 1a Personal Information | Borrower.workPhoneExt | borrowers[*].workPhoneExt | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].INDIVIDUAL.CONTACT_POINTS.CONTACT_POINT[*].CONTACT_POINT_TELEPHONE.ContactPointTelephoneExtensionValue | — | — |
| 18 | 1a Personal Information | MilitaryService.served | borrowers[*].militaryService.served | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.SelfDeclaredMilitaryServiceIndicator | — | — |
| 19 | 1a Personal Information | MilitaryService.status | borrowers[*].militaryService.status | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.MilitaryServiceStatusType | — | — |
| 20 | 1a Personal Information | MilitaryService.projectedExpirationDate | borrowers[*].militaryService.projectedExpirationDate | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.MilitaryServiceExpectedCompletionDate | — | — |
| 21 | 1a Address History | Borrower.currentAddress.street | borrowers[*].currentAddress.street | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.AddressLineText | — | — |
| 22 | 1a Address History | Borrower.currentAddress.unit | borrowers[*].currentAddress.unit | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.AddressUnitIdentifier | — | — |
| 23 | 1a Address History | Borrower.currentAddress.city | borrowers[*].currentAddress.city | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.CityName | — | — |
| 24 | 1a Address History | Borrower.currentAddress.state | borrowers[*].currentAddress.state | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.StateCode | — | — |
| 25 | 1a Address History | Borrower.currentAddress.zip | borrowers[*].currentAddress.zip | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.PostalCode | — | — |
| 26 | 1a Address History | Borrower.currentAddress.county | borrowers[*].currentAddress.county | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.CountyName | — | — |
| 27 | 1a Address History | Borrower.housingStatus | borrowers[*].housingStatus | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].RESIDENCE_DETAIL.BorrowerResidencyBasisType | — | — |
| 28 | 1a Address History | Borrower.monthlyRent | borrowers[*].monthlyRent | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].RESIDENCE_DETAIL.ResidenceMonthlyRentAmount | — | — |
| 29 | 1a Address History | Borrower.yearsAtAddress | borrowers[*].yearsAtAddress | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].RESIDENCE_DETAIL.BorrowerResidencyDurationYearsCount | — | — |
| 30 | 1a Address History | Borrower.monthsAtAddress | borrowers[*].monthsAtAddress | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].RESIDENCE_DETAIL.BorrowerResidencyDurationMonthsCount | — | — |
| 31 | 1a Address History | PreviousAddress.address.street | borrowers[*].previousAddresses[*].address.street | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.AddressLineText | — | — |
| 32 | 1a Address History | PreviousAddress.address.city | borrowers[*].previousAddresses[*].address.city | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].ADDRESS.CityName | — | — |
| 33 | 1a Address History | PreviousAddress.housingStatus | borrowers[*].previousAddresses[*].housingStatus | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].RESIDENCE_DETAIL.BorrowerResidencyBasisType | — | — |
| 34 | 1a Address History | PreviousAddress.yearsAtAddress | borrowers[*].previousAddresses[*].yearsAtAddress | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].RESIDENCE_DETAIL.BorrowerResidencyDurationYearsCount | — | — |
| 35 | 1a Address History | PreviousAddress.monthsAtAddress | borrowers[*].previousAddresses[*].monthsAtAddress | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.RESIDENCES.RESIDENCE[*].RESIDENCE_DETAIL.BorrowerResidencyDurationMonthsCount | — | — |
| 36 | 1b Current Employment | EmploymentRecord.employerName | borrowers[*].employments[*].employerName | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].LEGAL_ENTITY.LEGAL_ENTITY_DETAIL.FullName | — | — |
| 37 | 1b Current Employment | EmploymentRecord.employerAddress.street | borrowers[*].employments[*].employerAddress.street | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].ADDRESS.AddressLineText | — | — |
| 38 | 1b Current Employment | EmploymentRecord.employerAddress.city | borrowers[*].employments[*].employerAddress.city | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].ADDRESS.CityName | — | — |
| 39 | 1b Current Employment | EmploymentRecord.employerPhone | borrowers[*].employments[*].employerPhone | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmployerTelephoneValue | — | — |
| 40 | 1b Current Employment | EmploymentRecord.position | borrowers[*].employments[*].position | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentPositionDescription | — | — |
| 41 | 1b Current Employment | EmploymentRecord.startDate | borrowers[*].employments[*].startDate | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentStartDate | — | — |
| 42 | 1b Current Employment | EmploymentRecord.yearsInLineOfWork | borrowers[*].employments[*].yearsInLineOfWork | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentTimeInLineOfWorkYearsCount | — | — |
| 43 | 1b Current Employment | EmploymentRecord.selfEmployed | borrowers[*].employments[*].selfEmployed | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentBorrowerSelfEmployedIndicator | — | — |
| 44 | 1b Current Employment | EmploymentRecord.employedByFamilyOrParty | borrowers[*].employments[*].employedByFamilyOrParty | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.SpecialBorrowerEmployerRelationshipIndicator | — | — |
| 45 | 1b Current Employment | EmploymentRecord.baseMonthlyIncome | borrowers[*].employments[*].baseMonthlyIncome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentBaseMonthlyIncomeAmount | — | — |
| 46 | 1b Current Employment | EmploymentRecord.overtime | borrowers[*].employments[*].overtime | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentOvertimeMonthlyIncomeAmount | — | — |
| 47 | 1b Current Employment | EmploymentRecord.bonus | borrowers[*].employments[*].bonus | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentBonusMonthlyIncomeAmount | — | — |
| 48 | 1b Current Employment | EmploymentRecord.commission | borrowers[*].employments[*].commission | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentCommissionMonthlyIncomeAmount | — | — |
| 49 | 1b Current Employment | EmploymentRecord.militaryEntitlements | borrowers[*].employments[*].militaryEntitlements | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentMilitaryEntitlementsMonthlyIncomeAmount | — | — |
| 50 | 1b Current Employment | EmploymentRecord.otherMonthlyIncome | borrowers[*].employments[*].otherMonthlyIncome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentOtherMonthlyIncomeAmount | — | — |
| 51 | 1b Current Employment | EmploymentRecord.selfEmployedMonthlyIncome | borrowers[*].employments[*].selfEmployedMonthlyIncome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentSelfEmployedMonthlyIncomeAmount | — | — |
| 52 | 1d Previous Employment | PreviousEmploymentRecord.employerName | borrowers[*].previousEmployments[*].employerName | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].LEGAL_ENTITY.LEGAL_ENTITY_DETAIL.FullName | — | — |
| 53 | 1d Previous Employment | PreviousEmploymentRecord.position | borrowers[*].previousEmployments[*].position | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentPositionDescription | — | — |
| 54 | 1d Previous Employment | PreviousEmploymentRecord.startDate | borrowers[*].previousEmployments[*].startDate | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentStartDate | — | — |
| 55 | 1d Previous Employment | PreviousEmploymentRecord.endDate | borrowers[*].previousEmployments[*].endDate | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentEndDate | — | — |
| 56 | 1d Previous Employment | PreviousEmploymentRecord.previousGrossMonthlyIncome | borrowers[*].previousEmployments[*].previousGrossMonthlyIncome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.EMPLOYERS.EMPLOYER[*].EMPLOYMENT.EmploymentPreviousGrossMonthlyIncomeAmount | — | — |
| 57 | 1e Other Income | OtherIncomeRecord.source | borrowers[*].otherIncome[*].source | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.CURRENT_INCOME.CURRENT_INCOME_ITEMS.CURRENT_INCOME_ITEM[*].CURRENT_INCOME_ITEM_DETAIL.IncomeType | — | — |
| 58 | 1e Other Income | OtherIncomeRecord.monthlyAmount | borrowers[*].otherIncome[*].monthlyAmount | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.CURRENT_INCOME.CURRENT_INCOME_ITEMS.CURRENT_INCOME_ITEM[*].CURRENT_INCOME_ITEM_DETAIL.CurrentIncomeMonthlyTotalAmount | — | — |
| 59 | 5a Declarations | Declarations.aOccupyPrimary | borrowers[*].declarations.aOccupyPrimary | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.IntentToOccupyPropertyAsPrimaryResidenceIndicator | — | — |
| 60 | 5a Declarations | Declarations.a1PriorOwnership | borrowers[*].declarations.a1PriorOwnership | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.HomeownerPastThreeYearsIndicator | — | — |
| 61 | 5a Declarations | Declarations.a1PropertyType | borrowers[*].declarations.a1PropertyType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PriorPropertyUsageType | — | — |
| 62 | 5a Declarations | Declarations.a1TitleHeld | borrowers[*].declarations.a1TitleHeld | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PriorPropertyTitleType | — | — |
| 63 | 5a Declarations | Declarations.bSellerRelationship | borrowers[*].declarations.bSellerRelationship | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.SpecialBorrowerSellerRelationshipIndicator | — | — |
| 64 | 5a Declarations | Declarations.cUndisclosedBorrowing | borrowers[*].declarations.cUndisclosedBorrowing | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.UndisclosedBorrowedFundsIndicator | — | — |
| 65 | 5a Declarations | Declarations.cAmount | borrowers[*].declarations.cAmount | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.UndisclosedBorrowedFundsAmount | — | — |
| 66 | 5a Declarations | Declarations.d1OtherMortgageApplication | borrowers[*].declarations.d1OtherMortgageApplication | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.UndisclosedMortgageApplicationIndicator | — | — |
| 67 | 5a Declarations | Declarations.d2NewCreditApplication | borrowers[*].declarations.d2NewCreditApplication | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.UndisclosedCreditApplicationIndicator | — | — |
| 68 | 5a Declarations | Declarations.ePriorityLien | borrowers[*].declarations.ePriorityLien | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PropertyProposedCleanEnergyLienIndicator | — | — |
| 69 | 5b Declarations | Declarations.fCosignerUndisclosed | borrowers[*].declarations.fCosignerUndisclosed | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.UndisclosedComakerOfNoteIndicator | — | — |
| 70 | 5b Declarations | Declarations.gOutstandingJudgments | borrowers[*].declarations.gOutstandingJudgments | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.OutstandingJudgmentsIndicator | — | — |
| 71 | 5b Declarations | Declarations.hFederalDebtDelinquent | borrowers[*].declarations.hFederalDebtDelinquent | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PresentlyDelinquentIndicator | — | — |
| 72 | 5b Declarations | Declarations.iPartyToLawsuit | borrowers[*].declarations.iPartyToLawsuit | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PartyToLawsuitIndicator | — | — |
| 73 | 5b Declarations | Declarations.jConveyedTitleInLieu | borrowers[*].declarations.jConveyedTitleInLieu | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PriorPropertyDeedInLieuConveyedIndicator | — | — |
| 74 | 5b Declarations | Declarations.kPreForeclosureSale | borrowers[*].declarations.kPreForeclosureSale | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PriorPropertyShortSaleCompletedIndicator | — | — |
| 75 | 5b Declarations | Declarations.lForeclosed | borrowers[*].declarations.lForeclosed | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.PriorPropertyForeclosureCompletedIndicator | — | — |
| 76 | 5b Declarations | Declarations.mBankruptcy | borrowers[*].declarations.mBankruptcy | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.BankruptcyIndicator | — | — |
| 77 | 5b Declarations | Declarations.mBankruptcyType | borrowers[*].declarations.mBankruptcyType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.DECLARATION.DECLARATION_DETAIL.BankruptcyChapterType | — | — |
| 78 | 8 Demographic Information | Demographics.ethnicity | borrowers[*].demographics.ethnicity[*] | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.GOVERNMENT_MONITORING.HMDA_ETHNICITIES.HMDA_ETHNICITY[*].HMDAEthnicityType | — | — |
| 79 | 8 Demographic Information | Demographics.ethnicityOtherDetail | borrowers[*].demographics.ethnicityOtherDetail | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.GOVERNMENT_MONITORING.GOVERNMENT_MONITORING_DETAIL.HMDAEthnicityOtherHispanicOrLatinoOriginDescription | — | — |
| 80 | 8 Demographic Information | Demographics.race | borrowers[*].demographics.race[*] | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.GOVERNMENT_MONITORING.HMDA_RACES.HMDA_RACE[*].HMDARaceType | — | — |
| 81 | 8 Demographic Information | Demographics.raceOtherDetails | borrowers[*].demographics.raceOtherDetails[*] | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.GOVERNMENT_MONITORING.GOVERNMENT_MONITORING_DETAIL.HMDARaceOtherDescription[*] | — | — |
| 82 | 8 Demographic Information | Demographics.sex | borrowers[*].demographics.sex | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.GOVERNMENT_MONITORING.GOVERNMENT_MONITORING_DETAIL.HMDAGenderType | — | — |
| 83 | 8 Demographic Information | Demographics.collectionMethod | borrowers[*].demographics.collectionMethod | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.GOVERNMENT_MONITORING.GOVERNMENT_MONITORING_DETAIL.ApplicationTakenMethodType | — | — |
| 84 | 8 Demographic Information | Demographics.visualObservation | borrowers[*].demographics.visualObservation | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.GOVERNMENT_MONITORING.GOVERNMENT_MONITORING_DETAIL.HMDAEthnicityCollectedBasedOnVisualObservationOrSurnameIndicator | — | — |
| 85 | Lender Loan Information | Application.applicationNumber | application.applicationNumber | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].LOAN_IDENTIFIERS.LOAN_IDENTIFIER[*].LoanIdentifier | — | — |
| 86 | Lender Loan Information | Application.submittedAt | application.submittedAt | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].LOAN_DETAIL.ApplicationReceivedDate | date-only | — |
| 87 | 4a Loan Information | LoanDetails.loanType | data.loan.loanType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].TERMS_OF_LOAN.MortgageType | — | — |
| 88 | 4a Loan Information | LoanDetails.loanPurpose | data.loan.loanPurpose | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].TERMS_OF_LOAN.LoanPurposeType | — | — |
| 89 | 4a Loan Information | LoanDetails.requestedLoanAmount | data.loan.requestedLoanAmount | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].TERMS_OF_LOAN.BaseLoanAmount | — | — |
| 90 | 4a Loan Information | LoanDetails.downPaymentAmount | data.loan.downPaymentAmount | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].TERMS_OF_LOAN.DownPaymentAmount | — | — |
| 91 | 4a Loan Information | LoanDetails.downPaymentSource | data.loan.downPaymentSource | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].TERMS_OF_LOAN.DownPaymentSourceType | — | — |
| 92 | 4a Loan Information | LoanDetails.amortizationType | data.loan.amortizationType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].AMORTIZATION.AMORTIZATION_RULE.AmortizationType | — | — |
| 93 | 4a Loan Information | LoanDetails.loanTermMonths | data.loan.loanTermMonths | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].AMORTIZATION.AMORTIZATION_RULE.LoanAmortizationPeriodCount | — | — |
| 94 | 4a Loan Information | LoanDetails.armInitialFixedMonths | data.loan.armInitialFixedMonths | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].AMORTIZATION.ARM.InitialFixedPeriodMonthsCount | — | — |
| 95 | 4a Loan Information | LoanDetails.armAdjustmentMonths | data.loan.armAdjustmentMonths | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].AMORTIZATION.ARM.AdjustmentPeriodMonthsCount | — | — |
| 96 | 4b Other New Mortgage Loans | OtherNewMortgage.creditor | data.loan.otherNewMortgages[*].creditor | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].CreditorName | — | — |
| 97 | 4b Other New Mortgage Loans | OtherNewMortgage.lienType | data.loan.otherNewMortgages[*].lienType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].LienPriorityType | — | — |
| 98 | 4b Other New Mortgage Loans | OtherNewMortgage.monthlyPayment | data.loan.otherNewMortgages[*].monthlyPayment | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].MonthlyPaymentAmount | — | — |
| 99 | 4b Other New Mortgage Loans | OtherNewMortgage.amount | data.loan.otherNewMortgages[*].amount | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].LoanAmount | — | — |
| 100 | 4b Other New Mortgage Loans | OtherNewMortgage.creditLimit | data.loan.otherNewMortgages[*].creditLimit | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].OTHER_NEW_MORTGAGES.OTHER_NEW_MORTGAGE[*].CreditLimitAmount | — | — |
| 101 | Refinance | RefinanceDetails.originalCost | data.loan.refinance.originalCost | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].REFINANCE.RefinanceOriginalCostAmount | — | — |
| 102 | Refinance | RefinanceDetails.existingLiens | data.loan.refinance.existingLiens | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].REFINANCE.RefinanceExistingLienAmount | — | — |
| 103 | Refinance | RefinanceDetails.purposeOfRefinance | data.loan.refinance.purposeOfRefinance | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].REFINANCE.RefinancePrimaryPurposeType | — | — |
| 104 | Refinance | RefinanceDetails.improvementsDescription | data.loan.refinance.improvementsDescription | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].REFINANCE.RefinanceImprovementsDescription | — | — |
| 105 | Refinance | RefinanceDetails.improvementsCost | data.loan.refinance.improvementsCost | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].REFINANCE.RefinanceImprovementCostsAmount | — | — |
| 106 | Qualification | Application.dti | application.dti | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].QUALIFICATION.TotalDebtExpenseRatioPercent | — | Stored task-010 shared-module value (AC-13) |
| 107 | Qualification | Application.ltv | application.ltv | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].QUALIFICATION.LTVRatioPercent | — | Stored task-010 shared-module value (AC-13) |
| 108 | Qualification | Application.cltv | application.cltv | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].QUALIFICATION.CombinedLTVRatioPercent | — | Stored task-010 shared-module value (AC-13) |
| 109 | Qualification | CreditCheckResult.qualifyingScore | creditQualifyingScore | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].QUALIFICATION.QualifyingCreditScoreValue | — | ASM-003 lower-middle score from latest credit check |
| 110 | Proposed Housing Expense | ProposedHousingExpense.firstMortgagePi | data.proposedHousingExpense.firstMortgagePi | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "FirstMortgagePrincipalAndInterest" |
| 111 | Proposed Housing Expense | ProposedHousingExpense.subordinateLiens | data.proposedHousingExpense.subordinateLiens | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "SubordinateLienPayment" |
| 112 | Proposed Housing Expense | ProposedHousingExpense.homeownersInsurance | data.proposedHousingExpense.homeownersInsurance | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "HomeownersInsurance" |
| 113 | Proposed Housing Expense | ProposedHousingExpense.supplementalInsurance | data.proposedHousingExpense.supplementalInsurance | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "SupplementalPropertyInsurance" |
| 114 | Proposed Housing Expense | ProposedHousingExpense.propertyTaxes | data.proposedHousingExpense.propertyTaxes | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "RealEstateTax" |
| 115 | Proposed Housing Expense | ProposedHousingExpense.mortgageInsurance | data.proposedHousingExpense.mortgageInsurance | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "MortgageInsurance" |
| 116 | Proposed Housing Expense | ProposedHousingExpense.hoaDues | data.proposedHousingExpense.hoaDues | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "HomeownersAssociationDues" |
| 117 | Proposed Housing Expense | ProposedHousingExpense.other | data.proposedHousingExpense.other | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].HOUSING_EXPENSES.HOUSING_EXPENSE[*].HousingExpensePaymentAmount | — | Row tagged "Other" |
| 118 | 4c-4d Other Credits | OtherCreditRecord.type | data.otherCredits[*].type | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].PURCHASE_CREDITS.PURCHASE_CREDIT[*].PurchaseCreditType | — | — |
| 119 | 4c-4d Other Credits | OtherCreditRecord.sourceOrDonor | data.otherCredits[*].sourceOrDonor | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].PURCHASE_CREDITS.PURCHASE_CREDIT[*].PurchaseCreditSourceDescription | — | — |
| 120 | 4c-4d Other Credits | OtherCreditRecord.value | data.otherCredits[*].value | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LOANS.LOAN[*].PURCHASE_CREDITS.PURCHASE_CREDIT[*].PurchaseCreditAmount | — | — |
| 121 | 4a Property Information | SubjectProperty.address.street | data.subjectProperty.address.street | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.ADDRESS.AddressLineText | — | — |
| 122 | 4a Property Information | SubjectProperty.address.unit | data.subjectProperty.address.unit | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.ADDRESS.AddressUnitIdentifier | — | — |
| 123 | 4a Property Information | SubjectProperty.address.city | data.subjectProperty.address.city | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.ADDRESS.CityName | — | — |
| 124 | 4a Property Information | SubjectProperty.address.state | data.subjectProperty.address.state | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.ADDRESS.StateCode | — | — |
| 125 | 4a Property Information | SubjectProperty.address.zip | data.subjectProperty.address.zip | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.ADDRESS.PostalCode | — | — |
| 126 | 4a Property Information | SubjectProperty.address.county | data.subjectProperty.address.county | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.ADDRESS.CountyName | — | — |
| 127 | 4a Property Information | SubjectProperty.numberOfUnits | data.subjectProperty.numberOfUnits | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.FinancedUnitCount | — | — |
| 128 | 4a Property Information | SubjectProperty.propertyType | data.subjectProperty.propertyType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.PropertyType | — | — |
| 129 | 4a Property Information | SubjectProperty.occupancy | data.subjectProperty.occupancy | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.PropertyUsageType | — | — |
| 130 | 4a Property Information | SubjectProperty.mixedUse | data.subjectProperty.mixedUse | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.PropertyMixedUsageIndicator | — | — |
| 131 | 4a Property Information | SubjectProperty.manufacturedHome | data.subjectProperty.manufacturedHome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.ConstructionMethodType | construction-method | true→"Manufactured", false→"SiteBuilt" |
| 132 | 4a Property Information | SubjectProperty.estimatedValue | data.subjectProperty.estimatedValue | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.PropertyEstimatedValueAmount | — | — |
| 133 | 4a Property Information | SubjectProperty.expectedMonthlyRentalIncome | data.subjectProperty.expectedMonthlyRentalIncome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.PropertyExpectedMonthlyRentalIncomeAmount | — | — |
| 134 | Title Information | SubjectProperty.titleNames | data.subjectProperty.titleNames | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.PropertyTitleNamesDescription | — | — |
| 135 | Title Information | SubjectProperty.titleManner | data.subjectProperty.titleManner | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.TitleMannerHeldType | — | — |
| 136 | Title Information | SubjectProperty.estate | data.subjectProperty.estate | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.PropertyEstateType | — | — |
| 137 | Title Information | SubjectProperty.leaseholdExpirationDate | data.subjectProperty.leaseholdExpirationDate | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.LeaseholdExpirationDate | — | — |
| 138 | 4a Property Information | SubjectProperty.targetClosingDate | data.subjectProperty.targetClosingDate | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_DETAIL.TargetClosingDate | — | — |
| 139 | 4a Property Information | SubjectProperty.estimatedValue (valuation) | data.subjectProperty.estimatedValue | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.COLLATERALS.COLLATERAL[*].SUBJECT_PROPERTY.PROPERTY_VALUATIONS.PROPERTY_VALUATION[*].PROPERTY_VALUATION_DETAIL.PropertyValuationAmount | — | Borrower stated value; AVM row added when current (ASM-006) |
| 140 | 2a Assets | AssetRecord.accountType | data.assets[*].accountType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].ASSET_DETAIL.AssetType | — | — |
| 141 | 2a Assets | AssetRecord.financialInstitution | data.assets[*].financialInstitution | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].ASSET_HOLDER.NAME.FullName | — | — |
| 142 | 2a Assets | AssetRecord.accountNumberLast4 | data.assets[*].accountNumberLast4 | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].ASSET_DETAIL.AssetAccountIdentifier | — | Last four only; ciphertext never leaves system |
| 143 | 2a Assets | AssetRecord.cashOrMarketValue | data.assets[*].cashOrMarketValue | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].ASSET_DETAIL.AssetCashOrMarketValueAmount | — | — |
| 144 | 2a Assets | AssetRecord.source | data.assets[*].source | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].ASSET_DETAIL.FundsSourceType | — | — |
| 145 | 3 Real Estate Owned | RealEstateOwnedRecord.address.street | data.realEstateOwned[*].address.street | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.PROPERTY.ADDRESS.AddressLineText | — | — |
| 146 | 3 Real Estate Owned | RealEstateOwnedRecord.address.city | data.realEstateOwned[*].address.city | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.PROPERTY.ADDRESS.CityName | — | — |
| 147 | 3 Real Estate Owned | RealEstateOwnedRecord.propertyValue | data.realEstateOwned[*].propertyValue | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.PROPERTY.PropertyEstimatedValueAmount | — | — |
| 148 | 3 Real Estate Owned | RealEstateOwnedRecord.status | data.realEstateOwned[*].status | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_DETAIL.OwnedPropertyDispositionStatusType | — | — |
| 149 | 3 Real Estate Owned | RealEstateOwnedRecord.intendedOccupancy | data.realEstateOwned[*].intendedOccupancy | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_DETAIL.OwnedPropertyIntendedUsageType | — | — |
| 150 | 3 Real Estate Owned | RealEstateOwnedRecord.monthlyInsuranceTaxesHoa | data.realEstateOwned[*].monthlyInsuranceTaxesHoa | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_DETAIL.OwnedPropertyMaintenanceExpenseAmount | — | — |
| 151 | 3 Real Estate Owned | RealEstateOwnedRecord.monthlyRentalIncome | data.realEstateOwned[*].monthlyRentalIncome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_DETAIL.OwnedPropertyRentalIncomeGrossAmount | — | — |
| 152 | 3 Real Estate Owned | RealEstateOwnedRecord.netMonthlyRentalIncome | data.realEstateOwned[*].netMonthlyRentalIncome | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_DETAIL.OwnedPropertyRentalIncomeNetAmount | — | — |
| 153 | 3 Real Estate Owned | ReoMortgage.creditor | data.realEstateOwned[*].mortgages[*].creditor | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].CreditorName | — | — |
| 154 | 3 Real Estate Owned | ReoMortgage.accountNumberLast4 | data.realEstateOwned[*].mortgages[*].accountNumberLast4 | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].LiabilityAccountIdentifier | — | — |
| 155 | 3 Real Estate Owned | ReoMortgage.monthlyPayment | data.realEstateOwned[*].mortgages[*].monthlyPayment | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].MonthlyPaymentAmount | — | — |
| 156 | 3 Real Estate Owned | ReoMortgage.unpaidBalance | data.realEstateOwned[*].mortgages[*].unpaidBalance | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].UnpaidBalanceAmount | — | — |
| 157 | 3 Real Estate Owned | ReoMortgage.paidOffAtClosing | data.realEstateOwned[*].mortgages[*].paidOffAtClosing | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].PayoffAtClosingIndicator | — | — |
| 158 | 3 Real Estate Owned | ReoMortgage.mortgageType | data.realEstateOwned[*].mortgages[*].mortgageType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.ASSETS.ASSET[*].OWNED_PROPERTY.OWNED_PROPERTY_MORTGAGES.OWNED_PROPERTY_MORTGAGE[*].MortgageType | — | — |
| 159 | 2b Liabilities | LiabilityRecord.accountType | data.liabilities[*].accountType | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityType | — | — |
| 160 | 2b Liabilities | LiabilityRecord.companyName | data.liabilities[*].companyName | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_HOLDER.NAME.FullName | — | — |
| 161 | 2b Liabilities | LiabilityRecord.accountNumberLast4 | data.liabilities[*].accountNumberLast4 | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityAccountIdentifier | — | Last four only |
| 162 | 2b Liabilities | LiabilityRecord.unpaidBalance | data.liabilities[*].unpaidBalance | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityUnpaidBalanceAmount | — | — |
| 163 | 2b Liabilities | LiabilityRecord.monthlyPayment | data.liabilities[*].monthlyPayment | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityMonthlyPaymentAmount | — | — |
| 164 | 2b Liabilities | LiabilityRecord.monthsLeft | data.liabilities[*].monthsLeft | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityRemainingTermMonthsCount | — | — |
| 165 | 2b Liabilities | LiabilityRecord.paidOffAtClosing | data.liabilities[*].paidOffAtClosing | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityPayoffStatusIndicator | — | — |
| 166 | 2c Other Liabilities | OtherLiabilityRecord.type | data.otherLiabilities[*].type | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityType | — | — |
| 167 | 2c Other Liabilities | OtherLiabilityRecord.monthlyPayment | data.otherLiabilities[*].monthlyPayment | MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.LIABILITIES.LIABILITY[*].LIABILITY_DETAIL.LiabilityMonthlyPaymentAmount | — | — |

---

## Mapping Grammar & Conventions

### Source Path Grammar

A dot-path into `ApplicationExportData`:

- `borrowers[*].firstName` — every borrower's first name
- `data.loan.requestedLoanAmount` — the loan amount from application data
- `application.submittedAt` — application submission timestamp
- `[*]` on a segment means "every element of the array"; multiple `[*]` segments flatten

### Target Path Grammar

A dot-path into the MISMO logical document:

- In JSON: navigates nested objects/arrays
- In XML: each segment is a child element in MISMO namespace; `[*]` means repeated sibling elements
- Keys beginning with `@` are XML attributes (same-named keys in JSON)

### Transform Types

| Transform | Behavior |
|-----------|----------|
| `date-only` | Extracts ISO date part (YYYY-MM-DD) from ISO 8601 timestamp source |
| `construction-method` | Boolean `manufacturedHome` → `"Manufactured"` (true) or `"SiteBuilt"` (false) |
| `ssn-masked-or-full` | SSN masked to `***-**-NNNN` by default; full `NNN-NN-NNNN` only for audited `?full=true&reason=<text>` export (Supervisor role, audited) |
| `dob-display-to-iso` | `"Mon D, YYYY"` display source → ISO `YYYY-MM-DD` in the target, because `BorrowerBirthDate` is an `xs:date` element (INV-044 — MISMO JSON/XML exports only) |

---

## SSN and Encryption

**Masked Export (Default):** `GET /api/applications/:id/exports/mismo-json` returns SSN in TAXPAYER_IDENTIFIER element as `***-**-1234`.

**Full-SSN Audited Export:** `GET /api/applications/:id/exports/mismo-json?full=true&reason=compliance-audit` returns full `123-45-1234` with audit entry recording Supervisor ID, timestamp, and reason.

---

## AVM & Valuations

When an AVM result is current (non-stale per ASM-006):

- **Borrower-stated valuation** appears as PropertyEstimatedValueAmount
- **AVM valuation** appears as a second PropertyValuationAmount row tagged "AutomatedValuationModel"

Stale AVM (>30 days old) does not export as available; only stated value is used.

---

## Conformance Testing

Delivered test suite validates:

1. Every mapped field's value appears in its MISMO path
2. JSON and XML exports are well-formed
3. Masked vs full-SSN exports produce correct values
4. Array traversal (multiple borrowers, assets, etc.) produces correct repeated MISMO elements
5. Transforms (date-only, construction-method, dob-display-to-iso) produce correct output

---

## Reference

**Authority:** `src/lib/services/exports/mismo-mapping.ts` — 167-entry array, lines 73–262

**Related:** `src/lib/services/exports/application-export-data.ts` (ApplicationExportData loader), `src/lib/services/exports/mismo.ts` (MISMO document builder)

**Testing:** `task-047` (increment 12) evidence suite validates JSON and XML export against this mapping
