"use client";

// UrlaWizard (task-016) — Step 7: Loan Details (shared, §4.2.4). Purpose, type,
// amortization (+ARM periods), term, amount, down payment + source, other new
// mortgages, the FULL 8-field proposed monthly housing expense group (operator-
// approved contract delta: nested inside the loan-details payload), refinance
// conditional group. The live LTV badge lives in the chrome from this step on.

import type { LoanDetailsSection } from "../types";
import {
  AMORTIZATION_TYPE_OPTIONS,
  ASSET_ACCOUNT_TYPE_OPTIONS,
  LIEN_TYPE_OPTIONS,
  LOAN_PURPOSE_OPTIONS,
  LOAN_TERM_OPTIONS,
  LOAN_TYPE_OPTIONS,
  OTHER_CREDIT_TYPE_OPTIONS,
  REFINANCE_PURPOSE_OPTIONS,
} from "../types";
import {
  AddRowButton,
  CurrencyField,
  FieldGrid,
  GroupCard,
  IntField,
  SectionHeading,
  SelectField,
  TextField,
} from "../fields";

// Down payment source: "enum from Step 4 asset/credit types" (§4.2.4 Step 7).
const DOWN_PAYMENT_SOURCE_OPTIONS = [...ASSET_ACCOUNT_TYPE_OPTIONS, ...OTHER_CREDIT_TYPE_OPTIONS].filter(
  (o, i, all) => all.findIndex((x) => x.value === o.value) === i,
);

export function Step7LoanDetails({
  data,
  onChange,
  disabled,
  errorFor,
}: {
  data: LoanDetailsSection;
  onChange: (next: LoanDetailsSection) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
}) {
  const set = (patch: Partial<LoanDetailsSection>) => onChange({ ...data, ...patch });
  const isPurchase = data.loanPurpose === "purchase";
  const isRefinance = data.loanPurpose === "refinance-rate-term" || data.loanPurpose === "refinance-cash-out";
  const phe = data.proposedHousingExpense ?? {};
  const refi = data.refinance ?? {};
  const others = data.otherNewMortgages ?? [];

  const setPhe = (patch: Partial<typeof phe>) => set({ proposedHousingExpense: { ...phe, ...patch } });
  const setRefi = (patch: Partial<typeof refi>) => set({ refinance: { ...refi, ...patch } });

  return (
    <div className="space-y-8">
      <FieldGrid>
        <SelectField path="loanPurpose" label="Loan purpose" required value={data.loanPurpose} onChange={(v) => set({ loanPurpose: v })} options={LOAN_PURPOSE_OPTIONS} disabled={disabled} error={errorFor("loanPurpose")} />
        <SelectField path="loanType" label="Loan type" required value={data.loanType} onChange={(v) => set({ loanType: v })} options={LOAN_TYPE_OPTIONS} disabled={disabled} error={errorFor("loanType")} />
        <SelectField
          path="amortizationType"
          label="Amortization type"
          required
          value={data.amortizationType}
          onChange={(v) =>
            set({
              amortizationType: v,
              ...(v === "adjustable" ? {} : { armInitialFixedMonths: undefined, armAdjustmentMonths: undefined }),
            })
          }
          options={AMORTIZATION_TYPE_OPTIONS}
          disabled={disabled}
          error={errorFor("amortizationType")}
        />
        {data.amortizationType === "adjustable" ? (
          <>
            <IntField path="armInitialFixedMonths" label="Initial fixed period (months)" required min={0} value={data.armInitialFixedMonths} onChange={(v) => set({ armInitialFixedMonths: v })} disabled={disabled} error={errorFor("armInitialFixedMonths")} />
            <IntField path="armAdjustmentMonths" label="Adjustment period (months)" required min={0} value={data.armAdjustmentMonths} onChange={(v) => set({ armAdjustmentMonths: v })} disabled={disabled} error={errorFor("armAdjustmentMonths")} />
          </>
        ) : null}
        <SelectField
          path="loanTermMonths"
          label="Loan term"
          required
          value={data.loanTermMonths === undefined ? undefined : String(data.loanTermMonths)}
          onChange={(v) => set({ loanTermMonths: v === undefined ? undefined : Number(v) })}
          options={LOAN_TERM_OPTIONS}
          disabled={disabled}
          error={errorFor("loanTermMonths")}
        />
        <CurrencyField path="requestedLoanAmount" label="Requested loan amount" required value={data.requestedLoanAmount} onChange={(v) => set({ requestedLoanAmount: v })} disabled={disabled} error={errorFor("requestedLoanAmount")} />
        <CurrencyField path="downPaymentAmount" label="Down payment amount" required={isPurchase} value={data.downPaymentAmount} onChange={(v) => set({ downPaymentAmount: v })} disabled={disabled} error={errorFor("downPaymentAmount")} hint="Required for a purchase" />
        <SelectField
          path="downPaymentSource"
          label="Down payment source"
          required={isPurchase}
          value={data.downPaymentSource}
          onChange={(v) => set({ downPaymentSource: v })}
          options={DOWN_PAYMENT_SOURCE_OPTIONS}
          disabled={disabled}
          error={errorFor("downPaymentSource")}
        />
      </FieldGrid>

      <div>
        <SectionHeading sub="Homeowner's insurance and property taxes are required. First mortgage P&I is computed by underwriting.">
          Proposed monthly housing expense
        </SectionHeading>
        <div className="mt-3">
          <FieldGrid cols={4}>
            <CurrencyField path="proposedHousingExpense.firstMortgagePi" label="First mortgage P&I" value={phe.firstMortgagePi} onChange={(v) => setPhe({ firstMortgagePi: v })} disabled={disabled} error={errorFor("proposedHousingExpense.firstMortgagePi")} />
            <CurrencyField path="proposedHousingExpense.subordinateLiens" label="Subordinate liens" value={phe.subordinateLiens} onChange={(v) => setPhe({ subordinateLiens: v })} disabled={disabled} error={errorFor("proposedHousingExpense.subordinateLiens")} />
            <CurrencyField path="proposedHousingExpense.homeownersInsurance" label="Homeowner's insurance" required value={phe.homeownersInsurance} onChange={(v) => setPhe({ homeownersInsurance: v })} disabled={disabled} error={errorFor("proposedHousingExpense.homeownersInsurance")} />
            <CurrencyField path="proposedHousingExpense.supplementalInsurance" label="Supplemental insurance" value={phe.supplementalInsurance} onChange={(v) => setPhe({ supplementalInsurance: v })} disabled={disabled} error={errorFor("proposedHousingExpense.supplementalInsurance")} />
            <CurrencyField path="proposedHousingExpense.propertyTaxes" label="Property taxes" required value={phe.propertyTaxes} onChange={(v) => setPhe({ propertyTaxes: v })} disabled={disabled} error={errorFor("proposedHousingExpense.propertyTaxes")} />
            <CurrencyField path="proposedHousingExpense.mortgageInsurance" label="Mortgage insurance" value={phe.mortgageInsurance} onChange={(v) => setPhe({ mortgageInsurance: v })} disabled={disabled} error={errorFor("proposedHousingExpense.mortgageInsurance")} />
            <CurrencyField path="proposedHousingExpense.hoaDues" label="HOA dues" value={phe.hoaDues} onChange={(v) => setPhe({ hoaDues: v })} disabled={disabled} error={errorFor("proposedHousingExpense.hoaDues")} />
            <CurrencyField path="proposedHousingExpense.other" label="Other" value={phe.other} onChange={(v) => setPhe({ other: v })} disabled={disabled} error={errorFor("proposedHousingExpense.other")} />
          </FieldGrid>
        </div>
      </div>

      <div>
        <SectionHeading sub="Other new mortgage loans on the property (optional).">
          Other new mortgage loans
        </SectionHeading>
        <div className="mt-3 space-y-4">
          {others.map((m, i) => {
            const upd = (patch: Partial<typeof m>) => {
              const next = [...others];
              next[i] = { ...m, ...patch };
              set({ otherNewMortgages: next });
            };
            return (
              <GroupCard
                key={i}
                title={`Other new mortgage ${i + 1}`}
                disabled={disabled}
                onRemove={() => set({ otherNewMortgages: others.filter((_, j) => j !== i) })}
                removeTestId={`otherNewMortgages-remove-${i}`}
              >
                <FieldGrid cols={4}>
                  <TextField path={`otherNewMortgages.${i}.creditor`} label="Creditor" required value={m.creditor} onChange={(v) => upd({ creditor: v })} disabled={disabled} />
                  <SelectField path={`otherNewMortgages.${i}.lienType`} label="Lien type" value={m.lienType} onChange={(v) => upd({ lienType: v })} options={LIEN_TYPE_OPTIONS} disabled={disabled} />
                  <CurrencyField path={`otherNewMortgages.${i}.monthlyPayment`} label="Monthly payment" value={m.monthlyPayment} onChange={(v) => upd({ monthlyPayment: v })} disabled={disabled} />
                  <CurrencyField path={`otherNewMortgages.${i}.amount`} label="Loan amount" value={m.amount} onChange={(v) => upd({ amount: v })} disabled={disabled} />
                  <CurrencyField path={`otherNewMortgages.${i}.creditLimit`} label="Credit limit" value={m.creditLimit} onChange={(v) => upd({ creditLimit: v })} disabled={disabled} />
                </FieldGrid>
              </GroupCard>
            );
          })}
          <AddRowButton
            testId="otherNewMortgages-add"
            label="Add other new mortgage"
            disabled={disabled}
            onClick={() => set({ otherNewMortgages: [...others, { creditor: "" }] })}
          />
        </div>
      </div>

      {isRefinance ? (
        <div>
          <SectionHeading sub="Required for a refinance.">Refinance details</SectionHeading>
          <div className="mt-3">
            <FieldGrid>
              <CurrencyField path="refinance.originalCost" label="Original cost" required value={refi.originalCost} onChange={(v) => setRefi({ originalCost: v })} disabled={disabled} error={errorFor("refinance.originalCost") ?? errorFor("refinance")} />
              <CurrencyField path="refinance.existingLiens" label="Existing liens" required value={refi.existingLiens} onChange={(v) => setRefi({ existingLiens: v })} disabled={disabled} error={errorFor("refinance.existingLiens")} />
              <SelectField path="refinance.purposeOfRefinance" label="Purpose of refinance" required value={refi.purposeOfRefinance} onChange={(v) => setRefi({ purposeOfRefinance: v })} options={REFINANCE_PURPOSE_OPTIONS} disabled={disabled} error={errorFor("refinance.purposeOfRefinance")} />
              <TextField path="refinance.improvementsDescription" label="Improvements made / to be made" value={refi.improvementsDescription} onChange={(v) => setRefi({ improvementsDescription: v })} disabled={disabled} />
              <CurrencyField path="refinance.improvementsCost" label="Cost of improvements" value={refi.improvementsCost} onChange={(v) => setRefi({ improvementsCost: v })} disabled={disabled} />
            </FieldGrid>
          </div>
        </div>
      ) : null}
    </div>
  );
}
