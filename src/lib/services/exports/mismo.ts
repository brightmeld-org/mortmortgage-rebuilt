// MISMO v3.4 logical document builder + JSON/XML emitters (task-040,
// REQ-073 / REQ-074 / DATA-002, RFP §4.9.1-§4.9.2).
//
// ONE builder produces the logical container tree (MESSAGE > DEAL_SETS >
// DEAL_SET > DEALS > DEAL with PARTIES / LOANS / COLLATERALS / ASSETS /
// LIABILITIES / RELATIONSHIPS) from the shared masked loader's output; the
// JSON export serializes that tree directly and the XML export walks the SAME
// tree — the two formats are equivalent by construction (REQ-074 "equivalent
// structure").
//
// Conventions (documented in ./mismo-mapping.ts, the ASM-010 authority):
//   - PascalCase element names per the MISMO Reference Model; container keys
//     are the UPPERCASE plural/singular pairs (PARTIES > PARTY, ...). A plural
//     container holds its singular key with an ARRAY value; the XML emitter
//     repeats the singular element per item.
//   - Keys beginning with "@" are XML attributes (namespace declaration,
//     party/asset/liability labels for RELATIONSHIPS); JSON keeps them as
//     same-named keys.
//   - Values pass through as the contract's URLA value-set literals; every
//     value derives from live loaded data (LIVE-STATE rule) — the only fixed
//     literals are MISMO structural discriminators (e.g. TaxpayerIdentifierType
//     "SocialSecurityNumber", HousingExpenseType tags), each visible in the
//     mapping notes.
//   - XML is UTF-8 in the MISMO namespace with the five XML entities escaped
//     and XML-1.0-invalid control characters stripped, so unicode and
//     pipe-delimiter names survive intact (INV-036/INV-037).
//
// No XML library — hand-built with a small escaping helper (no-new-packages).

import type { ApplicationExportData, ExportBorrower } from "@/lib/services/exports/application-export-data";

export const MISMO_NAMESPACE = "http://www.mismo.org/residential/2009/schemas";

export type MismoValue = string | number | boolean;
export interface MismoNode {
  [key: string]: MismoValue | MismoNode | (MismoNode | MismoValue)[] | undefined;
}

// ---------------------------------------------------------------------------
// Safe readers over the loader's JSON-derived records
// ---------------------------------------------------------------------------

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v))
    : [];
}

/** Pass a scalar through; anything else (objects, arrays, null) is absent. */
function val(value: unknown): MismoValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const DOB_DISPLAY_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * INV-044: `BorrowerBirthDate` is an xs:date in the MISMO v3.4 schema, so it
 * MUST carry ISO YYYY-MM-DD. contracts.md §A otherwise states an unqualified
 * prohibition on raw ISO DOB egress (SEC-2); INV-044 carves the single
 * exception for the schema-typed date elements of the MISMO JSON and XML
 * exports. Every other API and UI surface keeps the "Mon D, YYYY" display form.
 *
 * The shared masked loader only ever hands this module `dateOfBirthDisplay`
 * (formatDobDisplay output) — the raw ISO value is never plumbed through the
 * export data — so this is a LOCAL inverse of that one format, kept inside the
 * MISMO serializer. Anything that is not that exact shape passes through
 * untouched rather than being guessed at.
 */
function dobDisplayToIso(value: unknown): MismoValue | undefined {
  const display = val(value);
  if (typeof display !== "string") return display;
  const m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(display.trim());
  if (!m) return display;
  const monthIndex = DOB_DISPLAY_MONTHS.indexOf(m[1] as (typeof DOB_DISPLAY_MONTHS)[number]);
  if (monthIndex < 0) return display;
  return `${m[3]}-${String(monthIndex + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/** Contract Address shape -> MISMO ADDRESS container. */
function address(value: unknown): MismoNode | undefined {
  const a = rec(value);
  if (Object.keys(a).length === 0) return undefined;
  return {
    AddressLineText: val(a.street),
    AddressUnitIdentifier: val(a.unit),
    CityName: val(a.city),
    StateCode: val(a.state),
    PostalCode: val(a.zip),
    CountyName: val(a.county),
    CountryCode: val(a.country),
  };
}

// ---------------------------------------------------------------------------
// Pruning — drop absent values and empty containers before emission
// ---------------------------------------------------------------------------

function pruneNode(node: MismoNode): MismoNode | undefined {
  const out: MismoNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const pruned = pruneNode(value);
      if (pruned !== undefined) out[key] = pruned;
    } else if (Array.isArray(value)) {
      const items = value
        .map((item) =>
          typeof item === "object" && item !== null ? pruneNode(item as MismoNode) : item,
        )
        .filter((item): item is MismoNode | MismoValue => item !== undefined && item !== null && item !== "");
      if (items.length > 0) out[key] = items;
    } else if (value !== "") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// PARTY (per borrower)
// ---------------------------------------------------------------------------

function contactPoints(b: ExportBorrower): MismoNode[] {
  const points: MismoNode[] = [];
  if (val(b.email) !== undefined) {
    points.push({ CONTACT_POINT_EMAIL: { ContactPointEmailValue: val(b.email) } });
  }
  const phones: [unknown, string, unknown?][] = [
    [b.homePhone, "Home"],
    [b.cellPhone, "Mobile"],
    [b.workPhone, "Work", b.workPhoneExt],
  ];
  for (const [number, role, ext] of phones) {
    if (val(number) === undefined) continue;
    points.push({
      CONTACT_POINT_TELEPHONE: {
        ContactPointTelephoneValue: val(number),
        ContactPointTelephoneExtensionValue: ext === undefined ? undefined : val(ext),
      },
      CONTACT_POINT_DETAIL: { ContactPointRoleType: role },
    });
  }
  return points;
}

function residences(b: ExportBorrower): MismoNode[] {
  const out: MismoNode[] = [];
  const current = address(b.currentAddress);
  if (current) {
    out.push({
      ADDRESS: current,
      RESIDENCE_DETAIL: {
        BorrowerResidencyType: "Current",
        BorrowerResidencyBasisType: val(b.housingStatus),
        BorrowerResidencyDurationYearsCount: val(b.yearsAtAddress),
        BorrowerResidencyDurationMonthsCount: val(b.monthsAtAddress),
        ResidenceMonthlyRentAmount: val(b.monthlyRent),
      },
    });
  }
  for (const prev of arr(b.previousAddresses)) {
    out.push({
      ADDRESS: address(prev.address),
      RESIDENCE_DETAIL: {
        BorrowerResidencyType: "Prior",
        BorrowerResidencyBasisType: val(prev.housingStatus),
        BorrowerResidencyDurationYearsCount: val(prev.yearsAtAddress),
        BorrowerResidencyDurationMonthsCount: val(prev.monthsAtAddress),
      },
    });
  }
  return out;
}

function employers(b: ExportBorrower): MismoNode[] {
  const out: MismoNode[] = [];
  for (const e of arr(b.employments)) {
    out.push({
      LEGAL_ENTITY: { LEGAL_ENTITY_DETAIL: { FullName: val(e.employerName) } },
      ADDRESS: address(e.employerAddress),
      EMPLOYMENT: {
        EmploymentStatusType: "Current",
        EmploymentPositionDescription: val(e.position),
        EmploymentStartDate: val(e.startDate),
        EmploymentTimeInLineOfWorkYearsCount: val(e.yearsInLineOfWork),
        EmploymentBorrowerSelfEmployedIndicator: val(e.selfEmployed),
        SpecialBorrowerEmployerRelationshipIndicator: val(e.employedByFamilyOrParty),
        OwnershipInterestType:
          e.ownershipShareGte25 === true
            ? "GreaterThanOrEqualTo25Percent"
            : e.ownershipShareGte25 === false
              ? "LessThan25Percent"
              : undefined,
        EmployerTelephoneValue: val(e.employerPhone),
        EmploymentBaseMonthlyIncomeAmount: val(e.baseMonthlyIncome),
        EmploymentOvertimeMonthlyIncomeAmount: val(e.overtime),
        EmploymentBonusMonthlyIncomeAmount: val(e.bonus),
        EmploymentCommissionMonthlyIncomeAmount: val(e.commission),
        EmploymentMilitaryEntitlementsMonthlyIncomeAmount: val(e.militaryEntitlements),
        EmploymentOtherMonthlyIncomeAmount: val(e.otherMonthlyIncome),
        EmploymentSelfEmployedMonthlyIncomeAmount: val(e.selfEmployedMonthlyIncome),
      },
    });
  }
  for (const e of arr(b.previousEmployments)) {
    out.push({
      LEGAL_ENTITY: { LEGAL_ENTITY_DETAIL: { FullName: val(e.employerName) } },
      ADDRESS: address(e.employerAddress),
      EMPLOYMENT: {
        EmploymentStatusType: "Previous",
        EmploymentPositionDescription: val(e.position),
        EmploymentStartDate: val(e.startDate),
        EmploymentEndDate: val(e.endDate),
        EmploymentPreviousGrossMonthlyIncomeAmount: val(e.previousGrossMonthlyIncome),
      },
    });
  }
  return out;
}

function declaration(b: ExportBorrower): MismoNode {
  const d = rec(b.declarations);
  return {
    DECLARATION_DETAIL: {
      IntentToOccupyPropertyAsPrimaryResidenceIndicator: val(d.aOccupyPrimary),
      HomeownerPastThreeYearsIndicator: val(d.a1PriorOwnership),
      PriorPropertyUsageType: val(d.a1PropertyType),
      PriorPropertyTitleType: val(d.a1TitleHeld),
      SpecialBorrowerSellerRelationshipIndicator: val(d.bSellerRelationship),
      UndisclosedBorrowedFundsIndicator: val(d.cUndisclosedBorrowing),
      UndisclosedBorrowedFundsAmount: val(d.cAmount),
      UndisclosedMortgageApplicationIndicator: val(d.d1OtherMortgageApplication),
      UndisclosedCreditApplicationIndicator: val(d.d2NewCreditApplication),
      PropertyProposedCleanEnergyLienIndicator: val(d.ePriorityLien),
      UndisclosedComakerOfNoteIndicator: val(d.fCosignerUndisclosed),
      OutstandingJudgmentsIndicator: val(d.gOutstandingJudgments),
      PresentlyDelinquentIndicator: val(d.hFederalDebtDelinquent),
      PartyToLawsuitIndicator: val(d.iPartyToLawsuit),
      PriorPropertyDeedInLieuConveyedIndicator: val(d.jConveyedTitleInLieu),
      PriorPropertyShortSaleCompletedIndicator: val(d.kPreForeclosureSale),
      PriorPropertyForeclosureCompletedIndicator: val(d.lForeclosed),
      BankruptcyIndicator: val(d.mBankruptcy),
      BankruptcyChapterType: val(d.mBankruptcyType),
    },
  };
}

function governmentMonitoring(b: ExportBorrower): MismoNode {
  const g = rec(b.demographics);
  return {
    GOVERNMENT_MONITORING_DETAIL: {
      HMDAGenderType: val(g.sex),
      ApplicationTakenMethodType: val(g.collectionMethod),
      HMDAEthnicityCollectedBasedOnVisualObservationOrSurnameIndicator: val(g.visualObservation),
      HMDAEthnicityOtherHispanicOrLatinoOriginDescription: val(g.ethnicityOtherDetail),
      HMDARaceOtherDescription: strArr(g.raceOtherDetails),
    },
    HMDA_ETHNICITIES: {
      HMDA_ETHNICITY: strArr(g.ethnicity).map((v) => ({ HMDAEthnicityType: v })),
    },
    HMDA_RACES: {
      HMDA_RACE: strArr(g.race).map((v) => ({ HMDARaceType: v })),
    },
  };
}

function party(b: ExportBorrower, label: string): MismoNode {
  const military = rec(b.militaryService);
  return {
    "@label": label,
    INDIVIDUAL: {
      NAME: {
        FirstName: val(b.firstName),
        MiddleName: val(b.middleName),
        LastName: val(b.lastName),
        SuffixName: val(b.suffix),
        AliasName: strArr(b.alternateNames),
      },
      CONTACT_POINTS: { CONTACT_POINT: contactPoints(b) },
    },
    TAXPAYER_IDENTIFIERS: {
      TAXPAYER_IDENTIFIER:
        val(b.ssnExportValue) === undefined
          ? []
          : [
              {
                TaxpayerIdentifierType: "SocialSecurityNumber",
                TaxpayerIdentifierValue: val(b.ssnExportValue),
              },
            ],
    },
    ROLES: {
      ROLE: [
        {
          ROLE_DETAIL: { PartyRoleType: "Borrower" },
          BORROWER: {
            BORROWER_DETAIL: {
              BorrowerClassificationType: b.ordinal === 1 ? "Primary" : "Secondary",
              // INV-044: xs:date -> ISO YYYY-MM-DD (MISMO exports only).
              BorrowerBirthDate: dobDisplayToIso(b.dateOfBirthDisplay),
              CitizenshipResidencyType: val(b.citizenship),
              MaritalStatusType: val(b.maritalStatus),
              DependentCount: val(b.dependentsCount),
              DependentAgesDescription: val(b.dependentsAges),
              JointAssetLiabilityReportingType: val(b.creditType),
              SelfDeclaredMilitaryServiceIndicator: val(military.served),
              MilitaryServiceStatusType: val(military.status),
              MilitaryServiceExpectedCompletionDate: val(military.projectedExpirationDate),
            },
            RESIDENCES: { RESIDENCE: residences(b) },
            EMPLOYERS: { EMPLOYER: employers(b) },
            CURRENT_INCOME: {
              CURRENT_INCOME_ITEMS: {
                CURRENT_INCOME_ITEM: arr(b.otherIncome).map((o) => ({
                  CURRENT_INCOME_ITEM_DETAIL: {
                    IncomeType: val(o.source),
                    CurrentIncomeMonthlyTotalAmount: val(o.monthlyAmount),
                  },
                })),
              },
            },
            DECLARATION: declaration(b),
            GOVERNMENT_MONITORING: governmentMonitoring(b),
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// LOAN / COLLATERAL / ASSETS / LIABILITIES / RELATIONSHIPS
// ---------------------------------------------------------------------------

const HOUSING_EXPENSE_TYPES: readonly [string, string][] = [
  ["firstMortgagePi", "FirstMortgagePrincipalAndInterest"],
  ["subordinateLiens", "SubordinateLienPayment"],
  ["homeownersInsurance", "HomeownersInsurance"],
  ["supplementalInsurance", "SupplementalPropertyInsurance"],
  ["propertyTaxes", "RealEstateTax"],
  ["mortgageInsurance", "MortgageInsurance"],
  ["hoaDues", "HomeownersAssociationDues"],
  ["other", "Other"],
];

function loanNode(data: ApplicationExportData): MismoNode {
  const loan = rec(data.data.loan);
  const refinance = rec(loan.refinance);
  const housing = rec(data.data.proposedHousingExpense);
  return {
    LOAN_IDENTIFIERS: {
      LOAN_IDENTIFIER: [
        { LoanIdentifier: data.application.applicationNumber, LoanIdentifierType: "LenderLoan" },
      ],
    },
    TERMS_OF_LOAN: {
      MortgageType: val(loan.loanType),
      LoanPurposeType: val(loan.loanPurpose),
      BaseLoanAmount: val(loan.requestedLoanAmount),
      DownPaymentAmount: val(loan.downPaymentAmount),
      DownPaymentSourceType: val(loan.downPaymentSource),
    },
    LOAN_DETAIL: {
      // ISO date part of the submission instant (documented in the mapping).
      ApplicationReceivedDate: data.application.submittedAt
        ? data.application.submittedAt.slice(0, 10)
        : undefined,
      BorrowerCount: data.borrowers.length,
    },
    AMORTIZATION: {
      AMORTIZATION_RULE: {
        AmortizationType: val(loan.amortizationType),
        LoanAmortizationPeriodCount: val(loan.loanTermMonths),
      },
      ARM:
        loan.amortizationType === "adjustable"
          ? {
              InitialFixedPeriodMonthsCount: val(loan.armInitialFixedMonths),
              AdjustmentPeriodMonthsCount: val(loan.armAdjustmentMonths),
            }
          : undefined,
    },
    QUALIFICATION: {
      TotalDebtExpenseRatioPercent: data.application.dti ?? undefined,
      LTVRatioPercent: data.application.ltv ?? undefined,
      CombinedLTVRatioPercent: data.application.cltv ?? undefined,
      QualifyingCreditScoreValue: data.creditQualifyingScore ?? undefined,
    },
    REFINANCE:
      Object.keys(refinance).length > 0
        ? {
            RefinanceOriginalCostAmount: val(refinance.originalCost),
            RefinanceExistingLienAmount: val(refinance.existingLiens),
            RefinancePrimaryPurposeType: val(refinance.purposeOfRefinance),
            RefinanceImprovementsDescription: val(refinance.improvementsDescription),
            RefinanceImprovementCostsAmount: val(refinance.improvementsCost),
          }
        : undefined,
    OTHER_NEW_MORTGAGES: {
      OTHER_NEW_MORTGAGE: arr(loan.otherNewMortgages).map((m) => ({
        CreditorName: val(m.creditor),
        LienPriorityType: val(m.lienType),
        MonthlyPaymentAmount: val(m.monthlyPayment),
        LoanAmount: val(m.amount),
        CreditLimitAmount: val(m.creditLimit),
      })),
    },
    PURCHASE_CREDITS: {
      PURCHASE_CREDIT: arr(data.data.otherCredits).map((c) => ({
        PurchaseCreditType: val(c.type),
        PurchaseCreditSourceDescription: val(c.sourceOrDonor),
        PurchaseCreditAmount: val(c.value),
      })),
    },
    HOUSING_EXPENSES: {
      HOUSING_EXPENSE: HOUSING_EXPENSE_TYPES.flatMap(([field, tag]) => {
        const amount = val(housing[field]);
        return amount === undefined
          ? []
          : [
              {
                HousingExpenseTimingType: "Proposed",
                HousingExpenseType: tag,
                HousingExpensePaymentAmount: amount,
              },
            ];
      }),
    },
  };
}

function subjectProperty(data: ApplicationExportData): MismoNode {
  const p = rec(data.data.subjectProperty);
  const valuations: MismoNode[] = [];
  if (val(p.estimatedValue) !== undefined) {
    valuations.push({
      PROPERTY_VALUATION_DETAIL: {
        PropertyValuationAmount: val(p.estimatedValue),
        PropertyValuationMethodType: "BorrowerEstimate",
      },
    });
  }
  if (data.avmValue !== null) {
    valuations.push({
      PROPERTY_VALUATION_DETAIL: {
        PropertyValuationAmount: data.avmValue,
        PropertyValuationMethodType: "AutomatedValuationModel",
      },
    });
  }
  return {
    ADDRESS: address(p.address),
    PROPERTY_DETAIL: {
      FinancedUnitCount: val(p.numberOfUnits),
      PropertyType: val(p.propertyType),
      PropertyUsageType: val(p.occupancy),
      PropertyMixedUsageIndicator: val(p.mixedUse),
      ConstructionMethodType:
        p.manufacturedHome === true ? "Manufactured" : p.manufacturedHome === false ? "SiteBuilt" : undefined,
      PropertyEstimatedValueAmount: val(p.estimatedValue),
      PropertyExpectedMonthlyRentalIncomeAmount: val(p.expectedMonthlyRentalIncome),
      PropertyTitleNamesDescription: val(p.titleNames),
      TitleMannerHeldType: val(p.titleManner),
      PropertyEstateType: val(p.estate),
      LeaseholdExpirationDate: val(p.leaseholdExpirationDate),
      TargetClosingDate: val(p.targetClosingDate),
    },
    PROPERTY_VALUATIONS: { PROPERTY_VALUATION: valuations },
  };
}

function assets(data: ApplicationExportData): { nodes: MismoNode[]; labels: string[] } {
  const nodes: MismoNode[] = [];
  const labels: string[] = [];
  arr(data.data.assets).forEach((a, i) => {
    const label = `ASSET_${i + 1}`;
    labels.push(label);
    nodes.push({
      "@label": label,
      ASSET_HOLDER: { NAME: { FullName: val(a.financialInstitution) } },
      ASSET_DETAIL: {
        AssetType: val(a.accountType),
        AssetAccountIdentifier: val(a.accountNumberLast4),
        AssetCashOrMarketValueAmount: val(a.cashOrMarketValue),
        FundsSourceType: val(a.source),
      },
    });
  });
  arr(data.data.realEstateOwned).forEach((r, i) => {
    const label = `REO_${i + 1}`;
    labels.push(label);
    nodes.push({
      "@label": label,
      OWNED_PROPERTY: {
        OWNED_PROPERTY_DETAIL: {
          OwnedPropertyDispositionStatusType: val(r.status),
          OwnedPropertyIntendedUsageType: val(r.intendedOccupancy),
          OwnedPropertyMaintenanceExpenseAmount: val(r.monthlyInsuranceTaxesHoa),
          OwnedPropertyRentalIncomeGrossAmount: val(r.monthlyRentalIncome),
          OwnedPropertyRentalIncomeNetAmount: val(r.netMonthlyRentalIncome),
        },
        PROPERTY: {
          ADDRESS: address(r.address),
          PropertyEstimatedValueAmount: val(r.propertyValue),
        },
        OWNED_PROPERTY_MORTGAGES: {
          OWNED_PROPERTY_MORTGAGE: arr(r.mortgages).map((m) => ({
            CreditorName: val(m.creditor),
            LiabilityAccountIdentifier: val(m.accountNumberLast4),
            MonthlyPaymentAmount: val(m.monthlyPayment),
            UnpaidBalanceAmount: val(m.unpaidBalance),
            PayoffAtClosingIndicator: val(m.paidOffAtClosing),
            MortgageType: val(m.mortgageType),
          })),
        },
      },
    });
  });
  return { nodes, labels };
}

function liabilities(data: ApplicationExportData): { nodes: MismoNode[]; labels: string[] } {
  const nodes: MismoNode[] = [];
  const labels: string[] = [];
  arr(data.data.liabilities).forEach((l, i) => {
    const label = `LIABILITY_${i + 1}`;
    labels.push(label);
    nodes.push({
      "@label": label,
      LIABILITY_HOLDER: { NAME: { FullName: val(l.companyName) } },
      LIABILITY_DETAIL: {
        LiabilityType: val(l.accountType),
        LiabilityAccountIdentifier: val(l.accountNumberLast4),
        LiabilityUnpaidBalanceAmount: val(l.unpaidBalance),
        LiabilityMonthlyPaymentAmount: val(l.monthlyPayment),
        LiabilityRemainingTermMonthsCount: val(l.monthsLeft),
        LiabilityPayoffStatusIndicator: val(l.paidOffAtClosing),
      },
    });
  });
  arr(data.data.otherLiabilities).forEach((l, i) => {
    const label = `OTHER_LIABILITY_${i + 1}`;
    labels.push(label);
    nodes.push({
      "@label": label,
      LIABILITY_DETAIL: {
        LiabilityType: val(l.type),
        LiabilityMonthlyPaymentAmount: val(l.monthlyPayment),
      },
    });
  });
  return { nodes, labels };
}

/**
 * RELATIONSHIPS linking parties to assets/liabilities. Assets and liabilities
 * are application-level URLA sections in this system (jointly stated), so
 * every borrower party is linked to every asset/REO/liability (documented in
 * the mapping module header's conventions).
 */
function relationships(
  partyLabels: string[],
  assetLabels: string[],
  liabilityLabels: string[],
): MismoNode[] {
  const out: MismoNode[] = [];
  for (const partyLabel of partyLabels) {
    for (const assetLabel of assetLabels) {
      out.push({
        "@from": partyLabel,
        "@to": assetLabel,
        RelationshipType: assetLabel.startsWith("REO_") ? "PropertyOwnedByParty" : "AssetOwnedByParty",
      });
    }
    for (const liabilityLabel of liabilityLabels) {
      out.push({
        "@from": partyLabel,
        "@to": liabilityLabel,
        RelationshipType: "LiabilityObligationOfParty",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** Build the pruned MISMO logical document (shared by JSON and XML). */
export function buildMismoDocument(data: ApplicationExportData): MismoNode {
  const partyLabels = data.borrowers.map((b) => `PARTY_${b.ordinal}`);
  const assetSet = assets(data);
  const liabilitySet = liabilities(data);

  const doc: MismoNode = {
    MESSAGE: {
      "@xmlns": MISMO_NAMESPACE,
      "@MISMOReferenceModelIdentifier": "3.4.0",
      DEAL_SETS: {
        DEAL_SET: {
          DEALS: {
            DEAL: {
              PARTIES: {
                PARTY: data.borrowers.map((b, i) => party(b, partyLabels[i])),
              },
              LOANS: { LOAN: [loanNode(data)] },
              COLLATERALS: {
                COLLATERAL: [{ SUBJECT_PROPERTY: subjectProperty(data) }],
              },
              ASSETS: { ASSET: assetSet.nodes },
              LIABILITIES: { LIABILITY: liabilitySet.nodes },
              RELATIONSHIPS: {
                RELATIONSHIP: relationships(partyLabels, assetSet.labels, liabilitySet.labels),
              },
            },
          },
        },
      },
    },
  };
  return pruneNode(doc) ?? {};
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/** JSON export body (UTF-8; unicode passes through natively — INV-037). */
export function mismoJson(doc: MismoNode): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Escape XML text/attribute content: the five predefined entities, with
 * XML-1.0-invalid control characters stripped (tab/newline/CR retained) so a
 * name can never break well-formedness.
 */
export function escapeXml(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function scalarText(value: MismoValue): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

function emitElement(
  name: string,
  value: MismoValue | MismoNode | (MismoNode | MismoValue)[],
  indent: string,
  lines: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) emitElement(name, item, indent, lines);
    return;
  }
  if (typeof value !== "object") {
    lines.push(`${indent}<${name}>${escapeXml(scalarText(value))}</${name}>`);
    return;
  }
  const attrs: string[] = [];
  const children: [string, MismoValue | MismoNode | (MismoNode | MismoValue)[]][] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (key.startsWith("@")) {
      if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
        attrs.push(` ${key.slice(1)}="${escapeXml(scalarText(child))}"`);
      }
    } else {
      children.push([key, child]);
    }
  }
  if (children.length === 0) {
    lines.push(`${indent}<${name}${attrs.join("")}/>`);
    return;
  }
  lines.push(`${indent}<${name}${attrs.join("")}>`);
  for (const [key, child] of children) emitElement(key, child, `${indent}  `, lines);
  lines.push(`${indent}</${name}>`);
}

/** XML export body: UTF-8 declaration + the document in the MISMO namespace. */
export function mismoXml(doc: MismoNode): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  for (const [name, value] of Object.entries(doc)) {
    if (value !== undefined) emitElement(name, value, "", lines);
  }
  return `${lines.join("\n")}\n`;
}
