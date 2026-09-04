"use client";

// UrlaWizard (task-016) — Step 3: Employment & Income (per borrower, §4.2.4).
// Repeating current employment groups with income fields, previous employment
// to 24-month coverage, other-income sources, employment type, and the
// bank-link entry point + income-evidence panel (REQ-039).

import type { EmploymentSection, IncomeEvidence } from "../types";
import { EMPLOYMENT_TYPE_OPTIONS, OTHER_INCOME_SOURCE_OPTIONS } from "../types";
import { AddressGroup } from "../AddressGroup";
import { formatCurrencyDisplay } from "../format";
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

export function Step3Employment({
  data,
  onChange,
  disabled,
  errorFor,
  onOpenBankLink,
  incomeEvidence,
  onAcceptIncomeEvidence,
}: {
  data: EmploymentSection;
  onChange: (next: EmploymentSection) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
  onOpenBankLink: () => void;
  incomeEvidence: IncomeEvidence[] | null;
  onAcceptIncomeEvidence: (evidence: IncomeEvidence) => void;
}) {
  const set = (patch: Partial<EmploymentSection>) => onChange({ ...data, ...patch });
  const emp = data.employments ?? [];
  const prevEmp = data.previousEmployments ?? [];
  const other = data.otherIncome ?? [];

  return (
    <div className="space-y-8">
      <FieldGrid>
        <SelectField
          path="employmentType"
          label="Employment type"
          required
          value={data.employmentType}
          onChange={(v) => set({ employmentType: v })}
          options={EMPLOYMENT_TYPE_OPTIONS}
          disabled={disabled}
          error={errorFor("employmentType")}
        />
      </FieldGrid>

      <div>
        <SectionHeading sub='At least one current employment is required unless "Not employed" is declared.'>
          Current employment
        </SectionHeading>
        <div className="mt-3 space-y-4">
          {emp.map((e, i) => {
            const upd = (patch: Partial<typeof e>) => {
              const next = [...emp];
              next[i] = { ...e, ...patch };
              set({ employments: next });
            };
            return (
              <GroupCard
                key={e.id ?? i}
                title={`Employment ${i + 1}`}
                disabled={disabled}
                onRemove={() => set({ employments: emp.filter((_, j) => j !== i) })}
                removeTestId={`employments-remove-${i}`}
              >
                <FieldGrid>
                  <TextField path={`employments.${i}.employerName`} label="Employer name" required value={e.employerName} onChange={(v) => upd({ employerName: v })} disabled={disabled} error={errorFor(`employments.${i}.employerName`) ?? (i === 0 ? errorFor("employments") : undefined)} />
                  <TextField path={`employments.${i}.employerPhone`} label="Employer phone" type="tel" value={e.employerPhone} onChange={(v) => upd({ employerPhone: v })} disabled={disabled} />
                  <TextField path={`employments.${i}.position`} label="Position / title" value={e.position} onChange={(v) => upd({ position: v })} disabled={disabled} />
                  <TextField path={`employments.${i}.startDate`} label="Start date" type="date" value={e.startDate} onChange={(v) => upd({ startDate: v })} disabled={disabled} />
                  <IntField path={`employments.${i}.yearsInLineOfWork`} label="Years in this line of work" min={0} value={e.yearsInLineOfWork} onChange={(v) => upd({ yearsInLineOfWork: v })} disabled={disabled} />
                </FieldGrid>
                <AddressGroup
                  basePath={`employments.${i}.employerAddress`}
                  label="Employer address"
                  value={e.employerAddress}
                  onChange={(a) => upd({ employerAddress: a })}
                  disabled={disabled}
                  errorFor={errorFor}
                />
                <div className="space-y-2">
                  <CheckField
                    path={`employments.${i}.selfEmployed`}
                    label="Self-employed"
                    checked={e.selfEmployed === true}
                    onChange={(v) => upd({ selfEmployed: v, ...(v ? {} : { ownershipShareGte25: undefined, selfEmployedMonthlyIncome: undefined }) })}
                    disabled={disabled}
                  />
                  {e.selfEmployed ? (
                    <CheckField
                      path={`employments.${i}.ownershipShareGte25`}
                      label="I have an ownership share of 25% or more"
                      checked={e.ownershipShareGte25 === true}
                      onChange={(v) => upd({ ownershipShareGte25: v })}
                      disabled={disabled}
                    />
                  ) : null}
                  <CheckField
                    path={`employments.${i}.employedByFamilyOrParty`}
                    label="Employed by a family member, property seller, real estate agent, or other party to the transaction"
                    checked={e.employedByFamilyOrParty === true}
                    onChange={(v) => upd({ employedByFamilyOrParty: v })}
                    disabled={disabled}
                  />
                </div>
                <div>
                  <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-soft">
                    Gross monthly income
                  </p>
                  <FieldGrid cols={4}>
                    <CurrencyField path={`employments.${i}.baseMonthlyIncome`} label="Base" required value={e.baseMonthlyIncome} onChange={(v) => upd({ baseMonthlyIncome: v })} disabled={disabled} error={errorFor(`employments.${i}.baseMonthlyIncome`)} />
                    <CurrencyField path={`employments.${i}.overtime`} label="Overtime" value={e.overtime} onChange={(v) => upd({ overtime: v })} disabled={disabled} />
                    <CurrencyField path={`employments.${i}.bonus`} label="Bonus" value={e.bonus} onChange={(v) => upd({ bonus: v })} disabled={disabled} />
                    <CurrencyField path={`employments.${i}.commission`} label="Commission" value={e.commission} onChange={(v) => upd({ commission: v })} disabled={disabled} />
                    <CurrencyField path={`employments.${i}.militaryEntitlements`} label="Military entitlements" value={e.militaryEntitlements} onChange={(v) => upd({ militaryEntitlements: v })} disabled={disabled} />
                    <CurrencyField path={`employments.${i}.otherMonthlyIncome`} label="Other" value={e.otherMonthlyIncome} onChange={(v) => upd({ otherMonthlyIncome: v })} disabled={disabled} />
                    {e.selfEmployed ? (
                      <CurrencyField
                        path={`employments.${i}.selfEmployedMonthlyIncome`}
                        label="Self-employed monthly income (or loss)"
                        required
                        allowNegative
                        value={e.selfEmployedMonthlyIncome}
                        onChange={(v) => upd({ selfEmployedMonthlyIncome: v })}
                        disabled={disabled}
                        error={errorFor(`employments.${i}.selfEmployedMonthlyIncome`)}
                      />
                    ) : null}
                  </FieldGrid>
                </div>
              </GroupCard>
            );
          })}
          {emp.length === 0 && errorFor("employments") ? (
            <p role="alert" className="text-xs text-danger">{errorFor("employments")}</p>
          ) : null}
          <AddRowButton
            testId="employments-add"
            label="Add current employment"
            disabled={disabled}
            onClick={() => set({ employments: [...emp, { employerName: "", selfEmployed: false }] })}
          />
        </div>
      </div>

      <div className="rounded-lg border border-info/30 bg-info-soft p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">Link a bank account</p>
            <p className="text-xs text-ink-soft">
              Import accounts and payroll income evidence from your bank (optional).
            </p>
          </div>
          <button
            type="button"
            data-testid="bank-link-btn"
            onClick={onOpenBankLink}
            disabled={disabled}
            className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-navy-deep active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Link a bank account
          </button>
        </div>
        {incomeEvidence && incomeEvidence.length > 0 ? (
          <div data-testid="income-evidence-panel" className="mt-4 space-y-2 border-t border-info/30 pt-3">
            <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">
              Income evidence — recurring payroll deposits (last 90 days)
            </p>
            {incomeEvidence.map((ev, i) => (
              <div key={i} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-card px-3 py-2">
                <div className="text-sm text-ink">
                  <span className="font-semibold">{ev.employerName}</span>
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${
                      ev.employerMatch ? "bg-success-soft text-success" : "bg-warn-soft text-warn"
                    }`}
                  >
                    {ev.employerMatch ? "matches Step 3 employer" : "no employer match"}
                  </span>
                  <span className="ml-3 text-ink-soft">
                    avg monthly deposit {formatCurrencyDisplay(ev.averageMonthlyDeposit)}
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="income-evidence-accept"
                  onClick={() => onAcceptIncomeEvidence(ev)}
                  disabled={disabled}
                  className="rounded-md border border-navy px-3 py-1.5 text-xs font-semibold text-navy transition-colors duration-200 hover:bg-navy/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Accept — pre-fill base income
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <SectionHeading sub="Required until employment history covers 24 months.">
          Previous employment
        </SectionHeading>
        <div className="mt-3 space-y-4">
          {prevEmp.map((p, i) => {
            const upd = (patch: Partial<typeof p>) => {
              const next = [...prevEmp];
              next[i] = { ...p, ...patch };
              set({ previousEmployments: next });
            };
            return (
              <GroupCard
                key={p.id ?? i}
                title={`Previous employment ${i + 1}`}
                disabled={disabled}
                onRemove={() => set({ previousEmployments: prevEmp.filter((_, j) => j !== i) })}
                removeTestId={`previousEmployments-remove-${i}`}
              >
                <FieldGrid>
                  <TextField path={`previousEmployments.${i}.employerName`} label="Employer name" required value={p.employerName} onChange={(v) => upd({ employerName: v })} disabled={disabled} />
                  <TextField path={`previousEmployments.${i}.position`} label="Position / title" value={p.position} onChange={(v) => upd({ position: v })} disabled={disabled} />
                  <TextField path={`previousEmployments.${i}.startDate`} label="Start date" required type="date" value={p.startDate} onChange={(v) => upd({ startDate: v })} disabled={disabled} />
                  <TextField path={`previousEmployments.${i}.endDate`} label="End date" required type="date" value={p.endDate} onChange={(v) => upd({ endDate: v })} disabled={disabled} />
                  <CurrencyField path={`previousEmployments.${i}.previousGrossMonthlyIncome`} label="Previous gross monthly income" value={p.previousGrossMonthlyIncome} onChange={(v) => upd({ previousGrossMonthlyIncome: v })} disabled={disabled} />
                </FieldGrid>
                <AddressGroup
                  basePath={`previousEmployments.${i}.employerAddress`}
                  label="Employer address"
                  value={p.employerAddress}
                  onChange={(a) => upd({ employerAddress: a })}
                  disabled={disabled}
                  errorFor={errorFor}
                />
              </GroupCard>
            );
          })}
          {errorFor("previousEmployments") ? (
            <p role="alert" className="text-xs text-danger">{errorFor("previousEmployments")}</p>
          ) : null}
          <AddRowButton
            testId="previousEmployments-add"
            label="Add previous employment"
            disabled={disabled}
            onClick={() =>
              set({ previousEmployments: [...prevEmp, { employerName: "", startDate: "", endDate: "" }] })
            }
          />
        </div>
      </div>

      <div>
        <SectionHeading sub="Income from other sources (optional).">Other income</SectionHeading>
        <div className="mt-3 space-y-4">
          {other.map((o, i) => (
            <GroupCard
              key={o.id ?? i}
              title={`Other income ${i + 1}`}
              disabled={disabled}
              onRemove={() => set({ otherIncome: other.filter((_, j) => j !== i) })}
              removeTestId={`otherIncome-remove-${i}`}
            >
              <FieldGrid cols={2}>
                <SelectField
                  path={`otherIncome.${i}.source`}
                  label="Source"
                  required
                  value={o.source}
                  onChange={(v) => {
                    const next = [...other];
                    next[i] = { ...o, source: v ?? "" };
                    set({ otherIncome: next });
                  }}
                  options={OTHER_INCOME_SOURCE_OPTIONS}
                  disabled={disabled}
                />
                <CurrencyField
                  path={`otherIncome.${i}.monthlyAmount`}
                  label="Monthly amount"
                  required
                  value={o.monthlyAmount}
                  onChange={(v) => {
                    const next = [...other];
                    next[i] = { ...o, monthlyAmount: v ?? (undefined as unknown as number) };
                    set({ otherIncome: next });
                  }}
                  disabled={disabled}
                />
              </FieldGrid>
            </GroupCard>
          ))}
          <AddRowButton
            testId="otherIncome-add"
            label="Add other income source"
            disabled={disabled}
            onClick={() =>
              set({ otherIncome: [...other, { source: "", monthlyAmount: undefined as unknown as number }] })
            }
          />
        </div>
      </div>
    </div>
  );
}
