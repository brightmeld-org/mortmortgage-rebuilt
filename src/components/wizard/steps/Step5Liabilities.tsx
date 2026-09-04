"use client";

// UrlaWizard (task-016) — Step 5: Liabilities (shared, §4.2.4). Repeating
// liabilities and other liabilities/expenses; the live DTI badge lives in the
// wizard chrome (right rail) from this step on.

import type { LiabilitiesSection } from "../types";
import { LIABILITY_ACCOUNT_TYPE_OPTIONS, OTHER_LIABILITY_TYPE_OPTIONS } from "../types";
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

export function Step5Liabilities({
  data,
  onChange,
  disabled,
  errorFor,
}: {
  data: LiabilitiesSection;
  onChange: (next: LiabilitiesSection) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
}) {
  const set = (patch: Partial<LiabilitiesSection>) => onChange({ ...data, ...patch });
  const liabilities = data.liabilities ?? [];
  const other = data.otherLiabilities ?? [];

  return (
    <div className="space-y-8">
      <div>
        <SectionHeading sub="Optional but recommended — payments not marked paid-off-at-closing count toward DTI.">
          Liabilities
        </SectionHeading>
        <div className="mt-3 space-y-4">
          {liabilities.map((l, i) => {
            const upd = (patch: Partial<typeof l>) => {
              const next = [...liabilities];
              next[i] = { ...l, ...patch };
              set({ liabilities: next });
            };
            return (
              <GroupCard
                key={l.id ?? i}
                title={`Liability ${i + 1}`}
                disabled={disabled}
                onRemove={() => set({ liabilities: liabilities.filter((_, j) => j !== i) })}
                removeTestId={`liabilities-remove-${i}`}
              >
                <FieldGrid cols={4}>
                  <SelectField
                    path={`liabilities.${i}.accountType`}
                    label="Account type"
                    required
                    value={l.accountType}
                    onChange={(v) => upd({ accountType: v ?? "" })}
                    options={LIABILITY_ACCOUNT_TYPE_OPTIONS}
                    disabled={disabled}
                  />
                  <TextField path={`liabilities.${i}.companyName`} label="Company name" value={l.companyName} onChange={(v) => upd({ companyName: v })} disabled={disabled} />
                  <TextField
                    path={`liabilities.${i}.accountNumber`}
                    label="Account number"
                    value={l.accountNumber}
                    onChange={(v) => upd({ accountNumber: v })}
                    placeholder={l.accountNumberLast4 ? `on file — ends in ${l.accountNumberLast4}` : undefined}
                    hint="Stored encrypted; last 4 shown"
                    disabled={disabled}
                  />
                  <CurrencyField path={`liabilities.${i}.unpaidBalance`} label="Unpaid balance" value={l.unpaidBalance} onChange={(v) => upd({ unpaidBalance: v })} disabled={disabled} />
                  <CurrencyField path={`liabilities.${i}.monthlyPayment`} label="Monthly payment" value={l.monthlyPayment} onChange={(v) => upd({ monthlyPayment: v })} disabled={disabled} />
                  <IntField path={`liabilities.${i}.monthsLeft`} label="Months left" min={0} value={l.monthsLeft} onChange={(v) => upd({ monthsLeft: v })} disabled={disabled} />
                </FieldGrid>
                <CheckField
                  path={`liabilities.${i}.paidOffAtClosing`}
                  label="To be paid off at or before closing"
                  checked={l.paidOffAtClosing === true}
                  onChange={(v) => upd({ paidOffAtClosing: v })}
                  disabled={disabled}
                />
              </GroupCard>
            );
          })}
          {errorFor("liabilities") ? (
            <p role="alert" className="text-xs text-danger">{errorFor("liabilities")}</p>
          ) : null}
          <AddRowButton
            testId="liabilities-add"
            label="Add liability"
            disabled={disabled}
            onClick={() => set({ liabilities: [...liabilities, { accountType: "" }] })}
          />
        </div>
      </div>

      <div>
        <SectionHeading sub="Alimony, child support, separate maintenance, job-related expenses (optional).">
          Other liabilities &amp; expenses
        </SectionHeading>
        <div className="mt-3 space-y-4">
          {other.map((o, i) => (
            <GroupCard
              key={o.id ?? i}
              title={`Other liability ${i + 1}`}
              disabled={disabled}
              onRemove={() => set({ otherLiabilities: other.filter((_, j) => j !== i) })}
              removeTestId={`otherLiabilities-remove-${i}`}
            >
              <FieldGrid cols={2}>
                <SelectField
                  path={`otherLiabilities.${i}.type`}
                  label="Type"
                  required
                  value={o.type}
                  onChange={(v) => {
                    const next = [...other];
                    next[i] = { ...o, type: v ?? "" };
                    set({ otherLiabilities: next });
                  }}
                  options={OTHER_LIABILITY_TYPE_OPTIONS}
                  disabled={disabled}
                />
                <CurrencyField
                  path={`otherLiabilities.${i}.monthlyPayment`}
                  label="Monthly payment"
                  required
                  value={o.monthlyPayment}
                  onChange={(v) => {
                    const next = [...other];
                    next[i] = { ...o, monthlyPayment: v ?? (undefined as unknown as number) };
                    set({ otherLiabilities: next });
                  }}
                  disabled={disabled}
                />
              </FieldGrid>
            </GroupCard>
          ))}
          <AddRowButton
            testId="otherLiabilities-add"
            label="Add other liability or expense"
            disabled={disabled}
            onClick={() =>
              set({ otherLiabilities: [...other, { type: "", monthlyPayment: undefined as unknown as number }] })
            }
          />
        </div>
      </div>
    </div>
  );
}
