"use client";

// UrlaWizard (task-016) — Step 1: Borrower Identity (per borrower, §4.2.4).
// Frame anchor: frame/screen-wizard1.png. All enum values verbatim from
// contracts.json; SSN masked-input pattern ###-##-#### (displayed as typed on
// this editable owner surface — the unmasked write value comes from the
// identity-own endpoint, the only unmasked read path).

import { useId } from "react";
import type { BorrowerIdentitySection } from "../types";
import {
  CITIZENSHIP_OPTIONS,
  CREDIT_TYPE_OPTIONS,
  MARITAL_STATUS_OPTIONS,
  MILITARY_SERVICE_STATUS_OPTIONS,
} from "../types";
import {
  AddRowButton,
  FieldGrid,
  IntField,
  SectionHeading,
  SelectField,
  TextField,
  YesNoField,
  inputClass,
} from "../fields";

function formatSsnInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 9);
  if (digits.length > 5) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  if (digits.length > 3) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return digits;
}

export function Step1Identity({
  data,
  onChange,
  disabled,
  errorFor,
  hasCoBorrower,
}: {
  data: BorrowerIdentitySection;
  onChange: (next: BorrowerIdentitySection) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
  hasCoBorrower: boolean;
}) {
  // NFR-025 / LENS-014: the SSN input is hand-rolled rather than a fields.tsx
  // primitive, so it carried the same omission YesNoField did — an error <p>
  // with no id that nothing pointed at.
  const ssnId = useId();
  const ssnErrorId = `${ssnId}-err`;
  const ssnHintId = `${ssnId}-hint`;
  const set = (patch: Partial<BorrowerIdentitySection>) => onChange({ ...data, ...patch });
  const ms = data.militaryService ?? { served: false };
  const altNames = data.alternateNames ?? [];

  return (
    <div className="space-y-8">
      <FieldGrid>
        <TextField path="firstName" label="First name" required value={data.firstName} onChange={(v) => set({ firstName: v })} disabled={disabled} error={errorFor("firstName")} />
        <TextField path="middleName" label="Middle name" value={data.middleName} onChange={(v) => set({ middleName: v })} disabled={disabled} error={errorFor("middleName")} />
        <TextField path="lastName" label="Last name" required value={data.lastName} onChange={(v) => set({ lastName: v })} disabled={disabled} error={errorFor("lastName")} />
        <TextField path="suffix" label="Suffix" value={data.suffix} onChange={(v) => set({ suffix: v })} disabled={disabled} error={errorFor("suffix")} />
        <div>
          <label htmlFor={ssnId} className="mb-1 block text-[13px] font-semibold text-ink">
            Social Security Number <span aria-hidden="true">*</span>
          </label>
          <input
            id={ssnId}
            data-testid="field-ssn"
            type="text"
            inputMode="numeric"
            placeholder="###-##-####"
            value={data.ssn ?? ""}
            onChange={(e) => set({ ssn: formatSsnInput(e.target.value) })}
            disabled={disabled}
            aria-invalid={errorFor("ssn") ? true : undefined}
            aria-describedby={errorFor("ssn") ? ssnErrorId : ssnHintId}
            className={`${inputClass} ${errorFor("ssn") ? "border-danger" : ""}`}
          />
          {errorFor("ssn") ? (
            <p id={ssnErrorId} role="alert" className="mt-1 text-xs text-danger">{errorFor("ssn")}</p>
          ) : (
            <p id={ssnHintId} className="mt-1 text-xs text-muted">Required — stored encrypted, shown masked</p>
          )}
        </div>
        <TextField path="dateOfBirth" label="Date of birth" required type="date" value={data.dateOfBirth} onChange={(v) => set({ dateOfBirth: v })} disabled={disabled} error={errorFor("dateOfBirth")} hint="Age ≥ 18 at application date" />
        <SelectField path="citizenship" label="Citizenship" required value={data.citizenship} onChange={(v) => set({ citizenship: v })} options={CITIZENSHIP_OPTIONS} disabled={disabled} error={errorFor("citizenship")} />
        <SelectField path="maritalStatus" label="Marital status" required value={data.maritalStatus} onChange={(v) => set({ maritalStatus: v })} options={MARITAL_STATUS_OPTIONS} disabled={disabled} error={errorFor("maritalStatus")} />
        <IntField path="dependentsCount" label="Dependents (count)" min={0} max={20} value={data.dependentsCount} onChange={(v) => set({ dependentsCount: v })} disabled={disabled} error={errorFor("dependentsCount")} />
        <TextField path="dependentsAges" label="Dependents' ages" value={data.dependentsAges} onChange={(v) => set({ dependentsAges: v })} placeholder="e.g. 4, 7" disabled={disabled} error={errorFor("dependentsAges")} />
      </FieldGrid>

      <div>
        <SectionHeading sub="At least one phone number is required.">Contact</SectionHeading>
        <div className="mt-3">
          <FieldGrid>
            <TextField path="homePhone" label="Home phone" type="tel" value={data.homePhone} onChange={(v) => set({ homePhone: v })} disabled={disabled} error={errorFor("homePhone")} />
            <TextField path="cellPhone" label="Cell phone" type="tel" value={data.cellPhone} onChange={(v) => set({ cellPhone: v })} disabled={disabled} error={errorFor("cellPhone")} />
            <TextField path="workPhone" label="Work phone" type="tel" value={data.workPhone} onChange={(v) => set({ workPhone: v })} disabled={disabled} error={errorFor("workPhone")} />
            <TextField path="workPhoneExt" label="Work phone ext." value={data.workPhoneExt} onChange={(v) => set({ workPhoneExt: v })} disabled={disabled} error={errorFor("workPhoneExt")} />
            <TextField path="email" label="Email" required type="email" value={data.email} onChange={(v) => set({ email: v })} disabled={disabled} error={errorFor("email")} hint="Defaults to account email" />
            <SelectField
              path="creditType"
              label="Type of credit"
              required
              value={data.creditType}
              onChange={(v) => set({ creditType: v })}
              options={CREDIT_TYPE_OPTIONS}
              disabled={disabled}
              error={errorFor("creditType")}
              hint={hasCoBorrower ? "Joint required when co-borrower present" : undefined}
            />
          </FieldGrid>
        </div>
      </div>

      <div>
        <SectionHeading sub="Alternate names used for credit (optional).">Alternate names</SectionHeading>
        <div className="mt-3 space-y-3">
          {altNames.map((name, i) => (
            <div key={i} className="flex items-center gap-3">
              <input
                data-testid={`field-alternateNames-${i}`}
                type="text"
                value={name}
                onChange={(e) => {
                  const next = [...altNames];
                  next[i] = e.target.value;
                  set({ alternateNames: next });
                }}
                disabled={disabled}
                className={inputClass}
              />
              <button
                type="button"
                data-testid={`alternateNames-remove-${i}`}
                onClick={() => set({ alternateNames: altNames.filter((_, j) => j !== i) })}
                disabled={disabled}
                className="text-xs font-semibold text-danger hover:opacity-70 disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ))}
          <AddRowButton testId="alternateNames-add" label="Add alternate name" disabled={disabled} onClick={() => set({ alternateNames: [...altNames, ""] })} />
        </div>
      </div>

      <div>
        <SectionHeading>Military service</SectionHeading>
        <div className="mt-3 space-y-4">
          <YesNoField
            path="militaryService.served"
            label="Did you (or your deceased spouse) ever serve, or are you currently serving, in the United States Armed Forces?"
            required
            value={ms.served}
            onChange={(v) => set({ militaryService: { ...ms, served: v, ...(v ? {} : { status: undefined, projectedExpirationDate: undefined }) } })}
            disabled={disabled}
            error={errorFor("militaryService.served")}
          />
          {ms.served ? (
            <FieldGrid cols={2}>
              <SelectField
                path="militaryService.status"
                label="Service status"
                required
                value={ms.status}
                onChange={(v) => set({ militaryService: { ...ms, status: v } })}
                options={MILITARY_SERVICE_STATUS_OPTIONS}
                disabled={disabled}
                error={errorFor("militaryService.status")}
              />
              {ms.status === "currently-serving" ? (
                <TextField
                  path="militaryService.projectedExpirationDate"
                  label="Projected expiration date of service/tour"
                  type="date"
                  value={ms.projectedExpirationDate}
                  onChange={(v) => set({ militaryService: { ...ms, projectedExpirationDate: v } })}
                  disabled={disabled}
                  error={errorFor("militaryService.projectedExpirationDate")}
                />
              ) : null}
            </FieldGrid>
          ) : null}
        </div>
      </div>
    </div>
  );
}
