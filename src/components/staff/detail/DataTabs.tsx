"use client";

// Data tabs for the staff application detail (task-029 — §4.4.3):
// Identity / Addresses / Employment & Income / Assets & REO / Liabilities /
// Property / Loan / Declarations / Demographics.
//
// Formats (§4.4.3): dates Mon D, YYYY (never raw ISO), currency $1,234.56,
// SSN masked (***-**-NNNN — the wire only ever carries ssnMasked). Co-borrower
// data clearly labeled (BorrowerScopeBadge on every per-borrower section).
// All fields read-only; correctable scalars carry the inline-correction
// affordance via FieldRow in staff-editable states (§4.4.4), with the
// corrected-field indicator + hover/focus provenance.
//
// Field paths handed to the correction API mirror the server correction root
// schemas verbatim (src/lib/services/corrections.ts): borrower-scoped paths
// with borrowerOrdinal, shared-section paths (assets[i]…, liabilities[i]…,
// subjectProperty…, loan…, proposedHousingExpense…) without.

import type { ReactNode } from "react";
import { formatCurrency, formatDate, humanizeEnum } from "@/components/borrower/format";
import type {
  AddressWire,
  ApplicationWire,
  BorrowerRecordWire,
} from "@/components/borrower/types";
import { BorrowerScopeBadge, DetailSection, EmptyLine, FieldGrid, FieldRow } from "./ui";
import type { CorrectableField, CorrectionsContext, FieldKind } from "./types";

// ---------------------------------------------------------------------------
// Wire extensions — §A fields the borrower surfaces never render but the staff
// detail does (names verbatim from contracts.json; optional throughout).
// ---------------------------------------------------------------------------

interface PreviousAddressWire {
  address?: AddressWire;
  housingStatus?: string;
  yearsAtAddress?: number;
  monthsAtAddress?: number;
}

interface MilitaryServiceWire {
  served?: boolean;
  status?: string;
  projectedExpirationDate?: string;
}

interface PreviousEmploymentWire {
  employerName?: string;
  position?: string;
  startDate?: string;
  endDate?: string;
  previousGrossMonthlyIncome?: number;
}

interface EmploymentFullWire {
  employerName?: string;
  employerAddress?: AddressWire;
  employerPhone?: string;
  position?: string;
  startDate?: string;
  yearsInLineOfWork?: number;
  selfEmployed?: boolean;
  ownershipShareGte25?: boolean;
  employedByFamilyOrParty?: boolean;
  baseMonthlyIncome?: number;
  overtime?: number;
  bonus?: number;
  commission?: number;
  militaryEntitlements?: number;
  otherMonthlyIncome?: number;
  selfEmployedMonthlyIncome?: number;
}

interface DemographicsWire {
  ethnicity?: string[];
  ethnicityOtherDetail?: string;
  race?: string[];
  raceOtherDetails?: string[];
  sex?: string;
  collectionMethod?: string;
  visualObservation?: boolean;
}

type BorrowerFull = Omit<BorrowerRecordWire, "employments" | "demographics"> & {
  alternateNames?: string[];
  dependentsAges?: string;
  workPhoneExt?: string;
  militaryService?: MilitaryServiceWire;
  previousAddresses?: PreviousAddressWire[];
  previousEmployments?: PreviousEmploymentWire[];
  employments?: EmploymentFullWire[];
  demographics?: DemographicsWire;
};

interface ReoMortgageWire {
  creditor?: string;
  accountNumberLast4?: string;
  monthlyPayment?: number;
  unpaidBalance?: number;
  paidOffAtClosing?: boolean;
  mortgageType?: string;
}

interface ProposedHousingExpenseWire {
  firstMortgagePi?: number;
  subordinateLiens?: number;
  homeownersInsurance?: number;
  supplementalInsurance?: number;
  propertyTaxes?: number;
  mortgageInsurance?: number;
  hoaDues?: number;
  other?: number;
}

interface RefinanceWire {
  originalCost?: number;
  existingLiens?: number;
  purposeOfRefinance?: string;
  improvementsDescription?: string;
  improvementsCost?: number;
}

interface OtherNewMortgageWire {
  creditor?: string;
  lienType?: string;
  monthlyPayment?: number;
  amount?: number;
  creditLimit?: number;
}

type BaseAppData = NonNullable<ApplicationWire["data"]>;

type AppData = Omit<BaseAppData, "realEstateOwned" | "otherCredits" | "subjectProperty" | "loan"> & {
  proposedHousingExpense?: ProposedHousingExpenseWire;
  realEstateOwned?: {
    address?: AddressWire;
    propertyValue?: number;
    status?: string;
    intendedOccupancy?: string;
    monthlyInsuranceTaxesHoa?: number;
    monthlyRentalIncome?: number;
    netMonthlyRentalIncome?: number;
    mortgages?: ReoMortgageWire[];
  }[];
  otherCredits?: { type?: string; sourceOrDonor?: string; value?: number }[];
  subjectProperty?: NonNullable<BaseAppData["subjectProperty"]> & {
    mixedUse?: boolean;
    manufacturedHome?: boolean;
    expectedMonthlyRentalIncome?: number;
    titleNames?: string;
    titleManner?: string;
    estate?: string;
    leaseholdExpirationDate?: string;
  };
  loan?: NonNullable<BaseAppData["loan"]> & {
    armInitialFixedMonths?: number;
    armAdjustmentMonths?: number;
    otherNewMortgages?: OtherNewMortgageWire[];
    refinance?: RefinanceWire;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DASH = "—";

function text(value: string | number | null | undefined): string {
  if (value === undefined || value === null || value === "") return DASH;
  return String(value);
}

function yesNo(value: boolean | null | undefined): string {
  if (value === undefined || value === null) return DASH;
  return value ? "Yes" : "No";
}

function addressLines(address: AddressWire | undefined): string {
  if (!address || (!address.street && !address.city)) return DASH;
  const line1 = [address.street, address.unit].filter(Boolean).join(", ");
  const line2 = [address.city, address.state, address.zip].filter(Boolean).join(", ");
  return [line1, line2].filter(Boolean).join(" · ");
}

function borrowerName(borrower: BorrowerRecordWire): string {
  const name = [borrower.firstName, borrower.lastName].filter(Boolean).join(" ");
  return name || DASH;
}

interface TabProps {
  app: ApplicationWire;
  corrections: CorrectionsContext;
}

/** Shorthand correctable-spec builder. */
function fld(
  fieldPath: string,
  kind: FieldKind,
  label: string,
  currentValue: unknown,
  borrowerOrdinal?: number,
): CorrectableField {
  return { fieldPath, kind, label, currentValue, borrowerOrdinal };
}

function perBorrowerSections(
  app: ApplicationWire,
  render: (borrower: BorrowerFull) => ReactNode,
): ReactNode {
  return (
    <div className="space-y-5">
      {app.borrowers.map((b) => (
        <div key={b.id}>{render(b as BorrowerFull)}</div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity (per borrower)
// ---------------------------------------------------------------------------

export function IdentityTab({ app, corrections }: TabProps) {
  return perBorrowerSections(app, (b) => (
    <DetailSection
      title="Identity"
      testId={`identity-section-${b.ordinal}`}
      aside={<BorrowerScopeBadge ordinal={b.ordinal} name={borrowerName(b)} />}
    >
      <FieldGrid>
        <FieldRow label="First name" value={text(b.firstName)} corrections={corrections} correctable={fld("firstName", "string", "First name", b.firstName, b.ordinal)} />
        <FieldRow label="Middle name" value={text(b.middleName)} corrections={corrections} correctable={fld("middleName", "string", "Middle name", b.middleName, b.ordinal)} />
        <FieldRow label="Last name" value={text(b.lastName)} corrections={corrections} correctable={fld("lastName", "string", "Last name", b.lastName, b.ordinal)} />
        <FieldRow label="Suffix" value={text(b.suffix)} corrections={corrections} correctable={fld("suffix", "string", "Suffix", b.suffix, b.ordinal)} />
        <FieldRow label="Alternate names" value={text((b.alternateNames ?? []).join(", "))} />
        <FieldRow label="SSN" value={<span data-testid={`ssn-masked-${b.ordinal}`}>{text(b.ssnMasked)}</span>} />
        <FieldRow label="Date of birth" value={<span data-testid={`dob-display-${b.ordinal}`}>{text(b.dateOfBirthDisplay)}</span>} />
        <FieldRow label="Citizenship" value={humanizeEnum(b.citizenship)} corrections={corrections} correctable={fld("citizenship", "string", "Citizenship", b.citizenship, b.ordinal)} />
        <FieldRow label="Marital status" value={humanizeEnum(b.maritalStatus)} corrections={corrections} correctable={fld("maritalStatus", "string", "Marital status", b.maritalStatus, b.ordinal)} />
        <FieldRow label="Dependents" value={text(b.dependentsCount)} corrections={corrections} correctable={fld("dependentsCount", "number", "Dependents", b.dependentsCount, b.ordinal)} />
        <FieldRow label="Dependents ages" value={text((b as BorrowerFull).dependentsAges)} corrections={corrections} correctable={fld("dependentsAges", "string", "Dependents ages", (b as BorrowerFull).dependentsAges, b.ordinal)} />
        <FieldRow label="Home phone" value={text(b.homePhone)} corrections={corrections} correctable={fld("homePhone", "string", "Home phone", b.homePhone, b.ordinal)} />
        <FieldRow label="Cell phone" value={text(b.cellPhone)} corrections={corrections} correctable={fld("cellPhone", "string", "Cell phone", b.cellPhone, b.ordinal)} />
        <FieldRow label="Work phone" value={text(b.workPhone)} corrections={corrections} correctable={fld("workPhone", "string", "Work phone", b.workPhone, b.ordinal)} />
        <FieldRow label="Email" value={text(b.email)} corrections={corrections} correctable={fld("email", "string", "Email", b.email, b.ordinal)} />
        <FieldRow label="Credit type" value={humanizeEnum(b.creditType)} />
        <FieldRow label="Military service" value={yesNo((b as BorrowerFull).militaryService?.served)} />
        {(b as BorrowerFull).militaryService?.served ? (
          <FieldRow label="Military status" value={humanizeEnum((b as BorrowerFull).militaryService?.status)} />
        ) : null}
      </FieldGrid>
    </DetailSection>
  ));
}

// ---------------------------------------------------------------------------
// Addresses (per borrower)
// ---------------------------------------------------------------------------

export function AddressesTab({ app, corrections }: TabProps) {
  return perBorrowerSections(app, (b) => (
    <DetailSection
      title="Addresses"
      testId={`addresses-section-${b.ordinal}`}
      aside={<BorrowerScopeBadge ordinal={b.ordinal} name={borrowerName(b)} />}
    >
      <FieldGrid>
        <FieldRow label="Current street" value={text(b.currentAddress?.street)} corrections={corrections} correctable={fld("currentAddress.street", "string", "Current street", b.currentAddress?.street, b.ordinal)} />
        <FieldRow label="Current city" value={text(b.currentAddress?.city)} corrections={corrections} correctable={fld("currentAddress.city", "string", "Current city", b.currentAddress?.city, b.ordinal)} />
        <FieldRow label="Current state" value={text(b.currentAddress?.state)} corrections={corrections} correctable={fld("currentAddress.state", "string", "Current state", b.currentAddress?.state, b.ordinal)} />
        <FieldRow label="Current ZIP" value={text(b.currentAddress?.zip)} corrections={corrections} correctable={fld("currentAddress.zip", "string", "Current ZIP", b.currentAddress?.zip, b.ordinal)} />
        <FieldRow label="Housing" value={humanizeEnum(b.housingStatus)} corrections={corrections} correctable={fld("housingStatus", "string", "Housing", b.housingStatus, b.ordinal)} />
        <FieldRow label="Monthly rent" value={formatCurrency(b.monthlyRent)} corrections={corrections} correctable={fld("monthlyRent", "number", "Monthly rent", b.monthlyRent, b.ordinal)} />
        <FieldRow label="Time at address" value={`${text(b.yearsAtAddress)} yr ${text(b.monthsAtAddress)} mo`} />
        <FieldRow label="Mailing address" value={addressLines(b.mailingAddress)} />
      </FieldGrid>
      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Previous addresses</h3>
      {((b as BorrowerFull).previousAddresses ?? []).length === 0 ? (
        <EmptyLine>None recorded.</EmptyLine>
      ) : (
        <ul className="mt-1 divide-y divide-line/60">
          {((b as BorrowerFull).previousAddresses ?? []).map((prev, i) => (
            <li key={i} className="py-2 text-sm text-ink">
              {addressLines(prev.address)}{" "}
              <span className="text-ink-soft">
                · {humanizeEnum(prev.housingStatus)} · {text(prev.yearsAtAddress)} yr {text(prev.monthsAtAddress)} mo
              </span>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  ));
}

// ---------------------------------------------------------------------------
// Employment & Income (per borrower)
// ---------------------------------------------------------------------------

export function EmploymentTab({ app, corrections }: TabProps) {
  return perBorrowerSections(app, (b) => {
    const full = b as BorrowerFull;
    return (
      <DetailSection
        title="Employment & Income"
        testId={`employment-section-${b.ordinal}`}
        aside={<BorrowerScopeBadge ordinal={b.ordinal} name={borrowerName(b)} />}
      >
        <FieldGrid>
          <FieldRow label="Employment type" value={humanizeEnum(b.employmentType)} corrections={corrections} correctable={fld("employmentType", "string", "Employment type", b.employmentType, b.ordinal)} />
        </FieldGrid>
        {(full.employments ?? []).map((job, i) => (
          <div key={i} className="mt-4 rounded-md border border-line/70 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Employment {i + 1}</h3>
            <FieldGrid>
              <FieldRow label="Employer" value={text(job.employerName)} corrections={corrections} correctable={fld(`employments[${i}].employerName`, "string", `Employer (employment ${i + 1})`, job.employerName, b.ordinal)} />
              <FieldRow label="Position" value={text(job.position)} corrections={corrections} correctable={fld(`employments[${i}].position`, "string", `Position (employment ${i + 1})`, job.position, b.ordinal)} />
              <FieldRow label="Start date" value={formatDate(job.startDate)} />
              <FieldRow label="Self-employed" value={yesNo(job.selfEmployed)} />
              <FieldRow label="Base monthly income" value={formatCurrency(job.baseMonthlyIncome)} corrections={corrections} correctable={fld(`employments[${i}].baseMonthlyIncome`, "number", `Base monthly income (employment ${i + 1})`, job.baseMonthlyIncome, b.ordinal)} />
              <FieldRow label="Overtime" value={formatCurrency(job.overtime)} corrections={corrections} correctable={fld(`employments[${i}].overtime`, "number", `Overtime (employment ${i + 1})`, job.overtime, b.ordinal)} />
              <FieldRow label="Bonus" value={formatCurrency(job.bonus)} corrections={corrections} correctable={fld(`employments[${i}].bonus`, "number", `Bonus (employment ${i + 1})`, job.bonus, b.ordinal)} />
              <FieldRow label="Commission" value={formatCurrency(job.commission)} corrections={corrections} correctable={fld(`employments[${i}].commission`, "number", `Commission (employment ${i + 1})`, job.commission, b.ordinal)} />
              {job.selfEmployed ? (
                <FieldRow label="Self-employed monthly income" value={formatCurrency(job.selfEmployedMonthlyIncome)} corrections={corrections} correctable={fld(`employments[${i}].selfEmployedMonthlyIncome`, "number", `Self-employed income (employment ${i + 1})`, job.selfEmployedMonthlyIncome, b.ordinal)} />
              ) : null}
            </FieldGrid>
          </div>
        ))}
        {(full.employments ?? []).length === 0 ? <EmptyLine>No current employment recorded.</EmptyLine> : null}

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Previous employment</h3>
        {(full.previousEmployments ?? []).length === 0 ? (
          <EmptyLine>None recorded.</EmptyLine>
        ) : (
          <ul className="mt-1 divide-y divide-line/60">
            {(full.previousEmployments ?? []).map((prev, i) => (
              <li key={i} className="py-2 text-sm text-ink">
                {text(prev.employerName)}{" "}
                <span className="text-ink-soft">
                  · {text(prev.position)} · {formatDate(prev.startDate)} – {formatDate(prev.endDate)} ·{" "}
                  {formatCurrency(prev.previousGrossMonthlyIncome)}/mo
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Other income</h3>
        {(b.otherIncome ?? []).length === 0 ? (
          <EmptyLine>None recorded.</EmptyLine>
        ) : (
          <FieldGrid>
            {(b.otherIncome ?? []).map((row, i) => (
              <FieldRow
                key={i}
                label={humanizeEnum(row.source)}
                value={`${formatCurrency(row.monthlyAmount)}/mo`}
                corrections={corrections}
                correctable={fld(`otherIncome[${i}].monthlyAmount`, "number", `Other income — ${humanizeEnum(row.source)}`, row.monthlyAmount, b.ordinal)}
              />
            ))}
          </FieldGrid>
        )}
      </DetailSection>
    );
  });
}

// ---------------------------------------------------------------------------
// Assets & REO (shared)
// ---------------------------------------------------------------------------

export function AssetsTab({ app, corrections }: TabProps) {
  const data = (app.data ?? {}) as AppData;
  const assets = data.assets ?? [];
  const credits = data.otherCredits ?? [];
  const reo = data.realEstateOwned ?? [];
  return (
    <div className="space-y-5">
      <DetailSection title="Assets" testId="assets-section">
        {assets.length === 0 ? (
          <EmptyLine>No assets recorded.</EmptyLine>
        ) : (
          assets.map((asset, i) => (
            <div key={i} className="mt-2 rounded-md border border-line/70 p-4 first:mt-0">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Asset {i + 1}</h3>
              <FieldGrid>
                <FieldRow label="Account type" value={humanizeEnum(asset.accountType)} />
                <FieldRow label="Institution" value={text(asset.financialInstitution)} corrections={corrections} correctable={fld(`assets[${i}].financialInstitution`, "string", `Institution (asset ${i + 1})`, asset.financialInstitution)} />
                <FieldRow label="Account number" value={asset.accountNumberLast4 ? `••••${asset.accountNumberLast4}` : DASH} />
                <FieldRow label="Cash / market value" value={formatCurrency(asset.cashOrMarketValue)} corrections={corrections} correctable={fld(`assets[${i}].cashOrMarketValue`, "number", `Value (asset ${i + 1})`, asset.cashOrMarketValue)} />
                <FieldRow label="Source" value={humanizeEnum(asset.source)} />
              </FieldGrid>
            </div>
          ))
        )}
      </DetailSection>
      <DetailSection title="Other credits" testId="other-credits-section">
        {credits.length === 0 ? (
          <EmptyLine>None recorded.</EmptyLine>
        ) : (
          <FieldGrid>
            {credits.map((credit, i) => (
              <FieldRow
                key={i}
                label={`${humanizeEnum(credit.type)}${credit.sourceOrDonor ? ` — ${credit.sourceOrDonor}` : ""}`}
                value={formatCurrency(credit.value)}
                corrections={corrections}
                correctable={fld(`otherCredits[${i}].value`, "number", `Other credit ${i + 1}`, credit.value)}
              />
            ))}
          </FieldGrid>
        )}
      </DetailSection>
      <DetailSection title="Real estate owned" testId="reo-section">
        {reo.length === 0 ? (
          <EmptyLine>None recorded.</EmptyLine>
        ) : (
          reo.map((property, i) => (
            <div key={i} className="mt-2 rounded-md border border-line/70 p-4 first:mt-0">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Property {i + 1}</h3>
              <FieldGrid>
                <FieldRow label="Address" value={addressLines(property.address)} />
                <FieldRow label="Property value" value={formatCurrency(property.propertyValue)} corrections={corrections} correctable={fld(`realEstateOwned[${i}].propertyValue`, "number", `REO value (property ${i + 1})`, property.propertyValue)} />
                <FieldRow label="Status" value={humanizeEnum(property.status)} />
                <FieldRow label="Intended occupancy" value={humanizeEnum(property.intendedOccupancy)} />
                <FieldRow label="Monthly ins/taxes/HOA" value={formatCurrency(property.monthlyInsuranceTaxesHoa)} />
                <FieldRow label="Monthly rental income" value={formatCurrency(property.monthlyRentalIncome)} />
              </FieldGrid>
              {(property.mortgages ?? []).length > 0 ? (
                <ul className="mt-2 divide-y divide-line/60">
                  {(property.mortgages ?? []).map((mortgage, j) => (
                    <li key={j} className="py-2 text-sm text-ink">
                      {text(mortgage.creditor)}{" "}
                      <span className="text-ink-soft">
                        · {formatCurrency(mortgage.monthlyPayment)}/mo · balance {formatCurrency(mortgage.unpaidBalance)}
                        {mortgage.paidOffAtClosing ? " · paid off at closing" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))
        )}
      </DetailSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Liabilities (shared)
// ---------------------------------------------------------------------------

export function LiabilitiesTab({ app, corrections }: TabProps) {
  const data = (app.data ?? {}) as AppData;
  const liabilities = data.liabilities ?? [];
  const others = data.otherLiabilities ?? [];
  return (
    <div className="space-y-5">
      <DetailSection title="Liabilities" testId="liabilities-section">
        {liabilities.length === 0 ? (
          <EmptyLine>No liabilities recorded.</EmptyLine>
        ) : (
          liabilities.map((liability, i) => (
            <div key={i} className="mt-2 rounded-md border border-line/70 p-4 first:mt-0">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Liability {i + 1}</h3>
              <FieldGrid>
                <FieldRow label="Account type" value={humanizeEnum(liability.accountType)} />
                <FieldRow label="Company" value={text(liability.companyName)} corrections={corrections} correctable={fld(`liabilities[${i}].companyName`, "string", `Company (liability ${i + 1})`, liability.companyName)} />
                <FieldRow label="Account number" value={liability.accountNumberLast4 ? `••••${liability.accountNumberLast4}` : DASH} />
                <FieldRow label="Unpaid balance" value={formatCurrency(liability.unpaidBalance)} corrections={corrections} correctable={fld(`liabilities[${i}].unpaidBalance`, "number", `Unpaid balance (liability ${i + 1})`, liability.unpaidBalance)} />
                <FieldRow label="Monthly payment" value={formatCurrency(liability.monthlyPayment)} corrections={corrections} correctable={fld(`liabilities[${i}].monthlyPayment`, "number", `Monthly payment (liability ${i + 1})`, liability.monthlyPayment)} />
              </FieldGrid>
            </div>
          ))
        )}
      </DetailSection>
      <DetailSection title="Other liabilities" testId="other-liabilities-section">
        {others.length === 0 ? (
          <EmptyLine>None recorded.</EmptyLine>
        ) : (
          <FieldGrid>
            {others.map((liability, i) => (
              <FieldRow
                key={i}
                label={humanizeEnum(liability.type)}
                value={`${formatCurrency(liability.monthlyPayment)}/mo`}
                corrections={corrections}
                correctable={fld(`otherLiabilities[${i}].monthlyPayment`, "number", `Other liability ${i + 1}`, liability.monthlyPayment)}
              />
            ))}
          </FieldGrid>
        )}
      </DetailSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Property (shared)
// ---------------------------------------------------------------------------

export function PropertyTab({ app, corrections }: TabProps) {
  const property = ((app.data ?? {}) as AppData).subjectProperty;
  if (!property) {
    return (
      <DetailSection title="Subject property" testId="property-section">
        <EmptyLine>No subject property recorded.</EmptyLine>
      </DetailSection>
    );
  }
  return (
    <DetailSection title="Subject property" testId="property-section">
      <FieldGrid>
        <FieldRow label="Street" value={text(property.address?.street)} corrections={corrections} correctable={fld("subjectProperty.address.street", "string", "Property street", property.address?.street)} />
        <FieldRow label="City" value={text(property.address?.city)} corrections={corrections} correctable={fld("subjectProperty.address.city", "string", "Property city", property.address?.city)} />
        <FieldRow label="State" value={text(property.address?.state)} corrections={corrections} correctable={fld("subjectProperty.address.state", "string", "Property state", property.address?.state)} />
        <FieldRow label="ZIP" value={text(property.address?.zip)} corrections={corrections} correctable={fld("subjectProperty.address.zip", "string", "Property ZIP", property.address?.zip)} />
        <FieldRow label="Units" value={text(property.numberOfUnits)} corrections={corrections} correctable={fld("subjectProperty.numberOfUnits", "number", "Units", property.numberOfUnits)} />
        <FieldRow label="Property type" value={humanizeEnum(property.propertyType)} />
        <FieldRow label="Occupancy" value={humanizeEnum(property.occupancy)} />
        <FieldRow label="Mixed use" value={yesNo(property.mixedUse)} />
        <FieldRow label="Manufactured home" value={yesNo(property.manufacturedHome)} />
        <FieldRow label="Estimated value" value={formatCurrency(property.estimatedValue)} corrections={corrections} correctable={fld("subjectProperty.estimatedValue", "number", "Estimated value", property.estimatedValue)} />
        <FieldRow label="Expected monthly rental income" value={formatCurrency(property.expectedMonthlyRentalIncome)} />
        <FieldRow label="Title names" value={text(property.titleNames)} />
        <FieldRow label="Estate" value={humanizeEnum(property.estate)} />
        <FieldRow label="Target closing date" value={formatDate(property.targetClosingDate)} />
      </FieldGrid>
    </DetailSection>
  );
}

// ---------------------------------------------------------------------------
// Loan (shared)
// ---------------------------------------------------------------------------

export function LoanTab({ app, corrections }: TabProps) {
  const data = (app.data ?? {}) as AppData;
  const loan = data.loan;
  const housing = data.proposedHousingExpense;
  return (
    <div className="space-y-5">
      <DetailSection title="Loan details" testId="loan-section">
        {!loan ? (
          <EmptyLine>No loan details recorded.</EmptyLine>
        ) : (
          <FieldGrid>
            <FieldRow label="Purpose" value={humanizeEnum(loan.loanPurpose)} />
            <FieldRow label="Loan type" value={humanizeEnum(loan.loanType)} />
            <FieldRow label="Amortization" value={humanizeEnum(loan.amortizationType)} />
            <FieldRow label="Term" value={loan.loanTermMonths ? `${loan.loanTermMonths} months` : DASH} corrections={corrections} correctable={fld("loan.loanTermMonths", "number", "Term (months)", loan.loanTermMonths)} />
            <FieldRow label="Requested loan amount" value={formatCurrency(loan.requestedLoanAmount)} corrections={corrections} correctable={fld("loan.requestedLoanAmount", "number", "Requested loan amount", loan.requestedLoanAmount)} />
            <FieldRow label="Down payment" value={formatCurrency(loan.downPaymentAmount)} corrections={corrections} correctable={fld("loan.downPaymentAmount", "number", "Down payment", loan.downPaymentAmount)} />
            <FieldRow label="Down payment source" value={text(loan.downPaymentSource)} corrections={corrections} correctable={fld("loan.downPaymentSource", "string", "Down payment source", loan.downPaymentSource)} />
          </FieldGrid>
        )}
        {loan?.refinance ? (
          <>
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Refinance</h3>
            <FieldGrid>
              <FieldRow label="Original cost" value={formatCurrency(loan.refinance.originalCost)} />
              <FieldRow label="Existing liens" value={formatCurrency(loan.refinance.existingLiens)} />
              <FieldRow label="Purpose of refinance" value={humanizeEnum(loan.refinance.purposeOfRefinance)} />
              <FieldRow label="Improvements cost" value={formatCurrency(loan.refinance.improvementsCost)} />
            </FieldGrid>
          </>
        ) : null}
        {(loan?.otherNewMortgages ?? []).length > 0 ? (
          <>
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Other new mortgages</h3>
            <ul className="mt-1 divide-y divide-line/60">
              {(loan?.otherNewMortgages ?? []).map((mortgage, i) => (
                <li key={i} className="py-2 text-sm text-ink">
                  {text(mortgage.creditor)}{" "}
                  <span className="text-ink-soft">
                    · {humanizeEnum(mortgage.lienType)} · {formatCurrency(mortgage.amount)} ·{" "}
                    {formatCurrency(mortgage.monthlyPayment)}/mo
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </DetailSection>
      <DetailSection title="Proposed monthly housing expense" testId="housing-expense-section">
        {!housing ? (
          <EmptyLine>Not recorded.</EmptyLine>
        ) : (
          <FieldGrid>
            <FieldRow label="First mortgage P&I" value={formatCurrency(housing.firstMortgagePi)} corrections={corrections} correctable={fld("proposedHousingExpense.firstMortgagePi", "number", "First mortgage P&I", housing.firstMortgagePi)} />
            <FieldRow label="Subordinate liens" value={formatCurrency(housing.subordinateLiens)} corrections={corrections} correctable={fld("proposedHousingExpense.subordinateLiens", "number", "Subordinate liens", housing.subordinateLiens)} />
            <FieldRow label="Homeowners insurance" value={formatCurrency(housing.homeownersInsurance)} corrections={corrections} correctable={fld("proposedHousingExpense.homeownersInsurance", "number", "Homeowners insurance", housing.homeownersInsurance)} />
            <FieldRow label="Supplemental insurance" value={formatCurrency(housing.supplementalInsurance)} corrections={corrections} correctable={fld("proposedHousingExpense.supplementalInsurance", "number", "Supplemental insurance", housing.supplementalInsurance)} />
            <FieldRow label="Property taxes" value={formatCurrency(housing.propertyTaxes)} corrections={corrections} correctable={fld("proposedHousingExpense.propertyTaxes", "number", "Property taxes", housing.propertyTaxes)} />
            <FieldRow label="Mortgage insurance" value={formatCurrency(housing.mortgageInsurance)} corrections={corrections} correctable={fld("proposedHousingExpense.mortgageInsurance", "number", "Mortgage insurance", housing.mortgageInsurance)} />
            <FieldRow label="HOA dues" value={formatCurrency(housing.hoaDues)} corrections={corrections} correctable={fld("proposedHousingExpense.hoaDues", "number", "HOA dues", housing.hoaDues)} />
            <FieldRow label="Other" value={formatCurrency(housing.other)} corrections={corrections} correctable={fld("proposedHousingExpense.other", "number", "Other housing expense", housing.other)} />
          </FieldGrid>
        )}
      </DetailSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Declarations (per borrower) — §4.2.4 letter labels
// ---------------------------------------------------------------------------

const DECLARATION_ITEMS: { key: string; label: string }[] = [
  { key: "aOccupyPrimary", label: "A. Will occupy as primary residence" },
  { key: "a1PriorOwnership", label: "A1. Ownership interest in a property (last 3 years)" },
  { key: "bSellerRelationship", label: "B. Relationship with the seller" },
  { key: "cUndisclosedBorrowing", label: "C. Borrowing undisclosed money for this transaction" },
  { key: "d1OtherMortgageApplication", label: "D1. Applying for another mortgage" },
  { key: "d2NewCreditApplication", label: "D2. Applying for new credit" },
  { key: "ePriorityLien", label: "E. Property subject to a priority lien" },
  { key: "fCosignerUndisclosed", label: "F. Co-signer or guarantor on undisclosed debt" },
  { key: "gOutstandingJudgments", label: "G. Outstanding judgments" },
  { key: "hFederalDebtDelinquent", label: "H. Delinquent on federal debt" },
  { key: "iPartyToLawsuit", label: "I. Party to a lawsuit" },
  { key: "jConveyedTitleInLieu", label: "J. Conveyed title in lieu of foreclosure" },
  { key: "kPreForeclosureSale", label: "K. Pre-foreclosure or short sale" },
  { key: "lForeclosed", label: "L. Property foreclosed upon" },
  { key: "mBankruptcy", label: "M. Declared bankruptcy (last 7 years)" },
];

export function DeclarationsTab({ app, corrections }: TabProps) {
  return perBorrowerSections(app, (b) => {
    const declarations = (b.declarations ?? {}) as Record<string, unknown>;
    return (
      <DetailSection
        title="Declarations"
        testId={`declarations-section-${b.ordinal}`}
        aside={<BorrowerScopeBadge ordinal={b.ordinal} name={borrowerName(b)} />}
      >
        <FieldGrid>
          {DECLARATION_ITEMS.map((item) => (
            <FieldRow
              key={item.key}
              label={item.label}
              value={yesNo(declarations[item.key] as boolean | undefined)}
              corrections={corrections}
              correctable={fld(`declarations.${item.key}`, "boolean", item.label, declarations[item.key], b.ordinal)}
            />
          ))}
          {declarations.cUndisclosedBorrowing === true ? (
            <FieldRow
              label="C. Amount borrowed"
              value={formatCurrency(declarations.cAmount as number | undefined)}
              corrections={corrections}
              correctable={fld("declarations.cAmount", "number", "C. Amount borrowed", declarations.cAmount, b.ordinal)}
            />
          ) : null}
          {declarations.mBankruptcy === true ? (
            <FieldRow label="M. Bankruptcy type" value={humanizeEnum(declarations.mBankruptcyType as string | undefined)} />
          ) : null}
        </FieldGrid>
      </DetailSection>
    );
  });
}

// ---------------------------------------------------------------------------
// Demographics (per borrower) — HMDA §4.2.4 step 9 (display only; the
// collection metadata is system-recorded and not correctable — DATA-003)
// ---------------------------------------------------------------------------

export function DemographicsTab({ app }: TabProps) {
  return perBorrowerSections(app, (b) => {
    const demographics = ((b as BorrowerFull).demographics ?? {}) as DemographicsWire;
    return (
      <DetailSection
        title="Demographics (HMDA)"
        testId={`demographics-section-${b.ordinal}`}
        aside={<BorrowerScopeBadge ordinal={b.ordinal} name={borrowerName(b)} />}
      >
        <FieldGrid>
          <FieldRow
            label="Ethnicity"
            value={(demographics.ethnicity ?? []).length > 0 ? (demographics.ethnicity ?? []).map((v) => humanizeEnum(v)).join("; ") : DASH}
          />
          {demographics.ethnicityOtherDetail ? (
            <FieldRow label="Ethnicity detail" value={demographics.ethnicityOtherDetail} />
          ) : null}
          <FieldRow
            label="Race"
            value={(demographics.race ?? []).length > 0 ? (demographics.race ?? []).map((v) => humanizeEnum(v)).join("; ") : DASH}
          />
          {(demographics.raceOtherDetails ?? []).length > 0 ? (
            <FieldRow label="Race detail" value={(demographics.raceOtherDetails ?? []).join("; ")} />
          ) : null}
          <FieldRow label="Sex" value={humanizeEnum(demographics.sex)} />
          <FieldRow label="Collection method" value={humanizeEnum(demographics.collectionMethod)} />
          <FieldRow label="Collected by visual observation" value={yesNo(demographics.visualObservation ?? false)} />
        </FieldGrid>
      </DetailSection>
    );
  });
}
