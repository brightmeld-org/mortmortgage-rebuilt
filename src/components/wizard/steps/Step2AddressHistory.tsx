"use client";

// UrlaWizard (task-016) — Step 2: Address History (per borrower, §4.2.4).
// Current address with autocomplete, housing status + conditional rent,
// years/months, repeating previous addresses until 24 months covered, mailing
// address toggle.

import type { AddressHistorySection } from "../types";
import { HOUSING_STATUS_OPTIONS } from "../types";
import { EMPTY_ADDRESS } from "../payload";
import { AddressGroup } from "../AddressGroup";
import {
  AddRowButton,
  CheckField,
  CurrencyField,
  FieldGrid,
  GroupCard,
  IntField,
  SectionHeading,
  SelectField,
  TextField,
} from "../fields";

export function Step2AddressHistory({
  data,
  onChange,
  disabled,
  errorFor,
}: {
  data: AddressHistorySection;
  onChange: (next: AddressHistorySection) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
}) {
  const set = (patch: Partial<AddressHistorySection>) => onChange({ ...data, ...patch });
  const prev = data.previousAddresses ?? [];

  const monthsCovered =
    (data.yearsAtAddress ?? 0) * 12 +
    (data.monthsAtAddress ?? 0) +
    prev.reduce((sum, p) => sum + (p.yearsAtAddress ?? 0) * 12 + (p.monthsAtAddress ?? 0), 0);

  return (
    <div className="space-y-8">
      <div>
        <SectionHeading>Current address</SectionHeading>
        <div className="mt-3 space-y-4">
          <AddressGroup
            basePath="currentAddress"
            required
            value={data.currentAddress}
            onChange={(a) => set({ currentAddress: a })}
            disabled={disabled}
            errorFor={errorFor}
            showCountry
          />
          <FieldGrid>
            <SelectField
              path="housingStatus"
              label="Housing status"
              required
              value={data.housingStatus}
              onChange={(v) =>
                set({ housingStatus: v, ...(v === "rent" ? {} : { monthlyRent: undefined }) })
              }
              options={HOUSING_STATUS_OPTIONS}
              disabled={disabled}
              error={errorFor("housingStatus")}
            />
            {data.housingStatus === "rent" ? (
              <CurrencyField
                path="monthlyRent"
                label="Monthly rent"
                required
                value={data.monthlyRent}
                onChange={(v) => set({ monthlyRent: v })}
                disabled={disabled}
                error={errorFor("monthlyRent")}
              />
            ) : null}
            <IntField path="yearsAtAddress" label="Years at address" required min={0} value={data.yearsAtAddress} onChange={(v) => set({ yearsAtAddress: v })} disabled={disabled} error={errorFor("yearsAtAddress")} />
            <IntField path="monthsAtAddress" label="Months at address" required min={0} max={11} value={data.monthsAtAddress} onChange={(v) => set({ monthsAtAddress: v })} disabled={disabled} error={errorFor("monthsAtAddress")} />
          </FieldGrid>
        </div>
      </div>

      <div>
        <SectionHeading
          sub={
            monthsCovered >= 24
              ? `Address history covers ${monthsCovered} months.`
              : `Address history covers ${monthsCovered} of 24 required months — add previous addresses until 24 months are covered.`
          }
        >
          Previous addresses
        </SectionHeading>
        <div className="mt-3 space-y-4">
          {prev.map((p, i) => (
            <GroupCard
              key={i}
              title={`Previous address ${i + 1}`}
              disabled={disabled}
              onRemove={() => set({ previousAddresses: prev.filter((_, j) => j !== i) })}
              removeTestId={`previousAddresses-remove-${i}`}
            >
              <AddressGroup
                basePath={`previousAddresses.${i}.address`}
                value={p.address}
                onChange={(a) => {
                  const next = [...prev];
                  next[i] = { ...p, address: a };
                  set({ previousAddresses: next });
                }}
                disabled={disabled}
                errorFor={errorFor}
              />
              <FieldGrid>
                <SelectField
                  path={`previousAddresses.${i}.housingStatus`}
                  label="Housing status"
                  value={p.housingStatus}
                  onChange={(v) => {
                    const next = [...prev];
                    next[i] = { ...p, housingStatus: v };
                    set({ previousAddresses: next });
                  }}
                  options={HOUSING_STATUS_OPTIONS}
                  disabled={disabled}
                />
                <IntField
                  path={`previousAddresses.${i}.yearsAtAddress`}
                  label="Years at address"
                  min={0}
                  value={p.yearsAtAddress}
                  onChange={(v) => {
                    const next = [...prev];
                    next[i] = { ...p, yearsAtAddress: v };
                    set({ previousAddresses: next });
                  }}
                  disabled={disabled}
                />
                <IntField
                  path={`previousAddresses.${i}.monthsAtAddress`}
                  label="Months at address"
                  min={0}
                  max={11}
                  value={p.monthsAtAddress}
                  onChange={(v) => {
                    const next = [...prev];
                    next[i] = { ...p, monthsAtAddress: v };
                    set({ previousAddresses: next });
                  }}
                  disabled={disabled}
                />
                {/* VR-132: interval endpoints — 24-month coverage is the
                    gap-free UNION of these spans, not the sum of durations. */}
                <TextField
                  path={`previousAddresses.${i}.fromDate`}
                  label="Moved in"
                  type="date"
                  required
                  hint="Required to submit — used to check for gaps in your 24-month history"
                  error={errorFor(`previousAddresses.${i}.fromDate`)}
                  value={p.fromDate}
                  onChange={(v) => {
                    const next = [...prev];
                    next[i] = { ...p, fromDate: v || undefined };
                    set({ previousAddresses: next });
                  }}
                  disabled={disabled}
                />
                <TextField
                  path={`previousAddresses.${i}.toDate`}
                  label="Moved out"
                  type="date"
                  required
                  hint="Required to submit — used to check for gaps in your 24-month history"
                  error={errorFor(`previousAddresses.${i}.toDate`)}
                  value={p.toDate}
                  onChange={(v) => {
                    const next = [...prev];
                    next[i] = { ...p, toDate: v || undefined };
                    set({ previousAddresses: next });
                  }}
                  disabled={disabled}
                />
              </FieldGrid>
            </GroupCard>
          ))}
          {errorFor("previousAddresses") ? (
            <p role="alert" className="text-xs text-danger">{errorFor("previousAddresses")}</p>
          ) : null}
          <AddRowButton
            testId="previousAddresses-add"
            label="Add previous address"
            disabled={disabled}
            onClick={() =>
              set({ previousAddresses: [...prev, { address: { ...EMPTY_ADDRESS } }] })
            }
          />
        </div>
      </div>

      <div>
        <SectionHeading>Mailing address</SectionHeading>
        <div className="mt-3 space-y-4">
          <CheckField
            path="mailingAddressDifferent"
            label="My mailing address is different from my current address"
            checked={data.mailingAddressDifferent === true}
            onChange={(v) =>
              set({
                mailingAddressDifferent: v,
                mailingAddress: v ? (data.mailingAddress ?? { ...EMPTY_ADDRESS }) : undefined,
              })
            }
            disabled={disabled}
          />
          {data.mailingAddressDifferent ? (
            <AddressGroup
              basePath="mailingAddress"
              value={data.mailingAddress}
              onChange={(a) => set({ mailingAddress: a })}
              disabled={disabled}
              errorFor={errorFor}
              showCountry
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
