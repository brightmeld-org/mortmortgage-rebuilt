"use client";

// UrlaWizard (task-016) — Step 6: Subject Property (shared, §4.2.4). Address
// with autocomplete (geocoded server-side on save, REQ-040), units, property
// type, occupancy, mixed-use/manufactured booleans, value, conditional rental
// income, title/estate fields, target closing date (req. for purchase).

import type { SubjectProperty } from "../types";
import {
  ESTATE_TYPE_OPTIONS,
  MANUFACTURED_HOME_LAND_INTEREST_OPTIONS,
  OCCUPANCY_TYPE_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  TITLE_MANNER_OPTIONS,
} from "../types";
import { AddressGroup } from "../AddressGroup";
import {
  CurrencyField,
  FieldGrid,
  IntField,
  SectionHeading,
  SelectField,
  TextField,
  YesNoField,
} from "../fields";

export function Step6SubjectProperty({
  data,
  onChange,
  disabled,
  errorFor,
  loanPurpose,
}: {
  data: SubjectProperty;
  onChange: (next: SubjectProperty) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
  loanPurpose: string | undefined;
}) {
  const set = (patch: Partial<SubjectProperty>) => onChange({ ...data, ...patch });

  const rentalConditional =
    data.occupancy === "investment-property" ||
    data.propertyType === "two-unit" ||
    data.propertyType === "three-unit" ||
    data.propertyType === "four-unit" ||
    (data.numberOfUnits !== undefined && data.numberOfUnits >= 2);

  return (
    <div className="space-y-8">
      <div>
        <SectionHeading sub="The property address is geocoded when saved.">Property address</SectionHeading>
        <div className="mt-3">
          <AddressGroup
            basePath="address"
            required
            value={data.address}
            onChange={(a) => set({ address: a })}
            disabled={disabled}
            errorFor={errorFor}
          />
        </div>
      </div>

      <FieldGrid>
        <IntField path="numberOfUnits" label="Number of units" required min={1} max={4} value={data.numberOfUnits} onChange={(v) => set({ numberOfUnits: v })} disabled={disabled} error={errorFor("numberOfUnits")} hint="1–4" />
        <SelectField path="propertyType" label="Property type" required value={data.propertyType} onChange={(v) => set({ propertyType: v })} options={PROPERTY_TYPE_OPTIONS} disabled={disabled} error={errorFor("propertyType")} />
        <SelectField path="occupancy" label="Occupancy" required value={data.occupancy} onChange={(v) => set({ occupancy: v })} options={OCCUPANCY_TYPE_OPTIONS} disabled={disabled} error={errorFor("occupancy")} />
        <CurrencyField path="estimatedValue" label="Estimated property value / purchase price" required value={data.estimatedValue} onChange={(v) => set({ estimatedValue: v })} disabled={disabled} error={errorFor("estimatedValue")} />
        {rentalConditional ? (
          <CurrencyField
            path="expectedMonthlyRentalIncome"
            label="Expected monthly rental income"
            value={data.expectedMonthlyRentalIncome}
            onChange={(v) => set({ expectedMonthlyRentalIncome: v })}
            disabled={disabled}
            error={errorFor("expectedMonthlyRentalIncome")}
            hint="2–4 units or investment property"
          />
        ) : null}
      </FieldGrid>

      <div className="space-y-4">
        <YesNoField
          path="mixedUse"
          label="Is the property a mixed-use property (e.g. part residential, part commercial)?"
          required
          value={data.mixedUse}
          onChange={(v) => set({ mixedUse: v })}
          disabled={disabled}
          error={errorFor("mixedUse")}
        />
        <YesNoField
          path="manufacturedHome"
          label="Is the property a manufactured home?"
          required
          value={data.manufacturedHome}
          onChange={(v) =>
            set({
              manufacturedHome: v,
              // VR-135: the land interest is meaningful only for a
              // manufactured home — clear it when the answer flips to No.
              ...(v === true ? {} : { manufacturedHomeLandInterest: undefined }),
            })
          }
          disabled={disabled}
          error={errorFor("manufacturedHome")}
        />
        {data.manufacturedHome === true ? (
          <div className="mt-4">
            <FieldGrid>
              <SelectField
                path="manufacturedHomeLandInterest"
                label="Interest in the land under the manufactured home"
                value={data.manufacturedHomeLandInterest}
                onChange={(v) => set({ manufacturedHomeLandInterest: v })}
                options={MANUFACTURED_HOME_LAND_INTEREST_OPTIONS}
                disabled={disabled}
                error={errorFor("manufacturedHomeLandInterest")}
              />
            </FieldGrid>
          </div>
        ) : null}
      </div>

      <div>
        <SectionHeading>Title &amp; estate</SectionHeading>
        <div className="mt-3">
          <FieldGrid>
            <TextField path="titleNames" label="Title will be held in what name(s)" required value={data.titleNames} onChange={(v) => set({ titleNames: v })} disabled={disabled} error={errorFor("titleNames")} />
            <SelectField path="titleManner" label="Manner in which title will be held" required value={data.titleManner} onChange={(v) => set({ titleManner: v })} options={TITLE_MANNER_OPTIONS} disabled={disabled} error={errorFor("titleManner")} />
            <SelectField
              path="estate"
              label="Estate"
              required
              value={data.estate}
              onChange={(v) => set({ estate: v, ...(v === "leasehold" ? {} : { leaseholdExpirationDate: undefined }) })}
              options={ESTATE_TYPE_OPTIONS}
              disabled={disabled}
              error={errorFor("estate")}
            />
            {data.estate === "leasehold" ? (
              <TextField path="leaseholdExpirationDate" label="Leasehold expiration date" required type="date" value={data.leaseholdExpirationDate} onChange={(v) => set({ leaseholdExpirationDate: v })} disabled={disabled} error={errorFor("leaseholdExpirationDate")} />
            ) : null}
            <TextField
              path="targetClosingDate"
              label="Target closing date"
              required={loanPurpose === "purchase"}
              type="date"
              value={data.targetClosingDate}
              onChange={(v) => set({ targetClosingDate: v })}
              disabled={disabled}
              error={errorFor("targetClosingDate")}
              hint="Required for a purchase"
            />
          </FieldGrid>
        </div>
      </div>
    </div>
  );
}
