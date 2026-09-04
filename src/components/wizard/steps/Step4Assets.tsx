"use client";

// UrlaWizard (task-016) — Step 4: Assets & Real Estate Owned (shared, §4.2.4).
// Repeating asset accounts (source badge manual/bank-link), other assets and
// credits, REO with per-property mortgage sub-group; bank-link entry point plus
// the active-links list with its Unlink action (BUG-28, REQ-039, §4.2.10).

import type { Application, AssetsSection, BankLinkInfo } from "../types";
import {
  ASSET_ACCOUNT_TYPE_OPTIONS,
  LOAN_TYPE_OPTIONS,
  OCCUPANCY_TYPE_OPTIONS,
  OTHER_CREDIT_TYPE_OPTIONS,
  REO_STATUS_OPTIONS,
} from "../types";
import { EMPTY_ADDRESS } from "../payload";
import { AddressGroup } from "../AddressGroup";
import { BankLinksPanel } from "../BankLinksPanel";
import {
  AddRowButton,
  CheckField,
  CurrencyField,
  FieldGrid,
  GroupCard,
  SectionHeading,
  SelectField,
  TextField,
} from "../fields";

function SourceBadge({ source }: { source?: string }) {
  const isBank = source === "bank-link";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal ${
        isBank ? "bg-info-soft text-info" : "bg-gray-soft text-ink-soft"
      }`}
    >
      {isBank ? "bank link" : "manual"}
    </span>
  );
}

export function Step4Assets({
  data,
  onChange,
  disabled,
  errorFor,
  onOpenBankLink,
  applicationId,
  csrfToken,
  bankLinks,
  onUnlinked,
}: {
  data: AssetsSection;
  onChange: (next: AssetsSection) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
  onOpenBankLink: () => void;
  applicationId: string;
  csrfToken: string;
  /** Application.bankLinks — active links only (CH-018, BUG-28). */
  bankLinks: BankLinkInfo[];
  onUnlinked: (app: Application) => void;
}) {
  const set = (patch: Partial<AssetsSection>) => onChange({ ...data, ...patch });
  const assets = data.assets ?? [];
  const credits = data.otherCredits ?? [];
  const reo = data.realEstateOwned ?? [];

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeading sub="At least one asset is required for submission.">
            Bank &amp; investment accounts
          </SectionHeading>
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
        <BankLinksPanel
          applicationId={applicationId}
          csrfToken={csrfToken}
          links={bankLinks}
          disabled={disabled}
          onUnlinked={onUnlinked}
        />
        <div className="mt-3 space-y-4">
          {assets.map((a, i) => {
            const upd = (patch: Partial<typeof a>) => {
              const next = [...assets];
              next[i] = { ...a, ...patch };
              set({ assets: next });
            };
            return (
              <GroupCard
                key={a.id ?? i}
                title={`Account ${i + 1}`}
                badge={<SourceBadge source={a.source} />}
                disabled={disabled}
                onRemove={() => set({ assets: assets.filter((_, j) => j !== i) })}
                removeTestId={`assets-remove-${i}`}
              >
                <FieldGrid cols={4}>
                  <SelectField
                    path={`assets.${i}.accountType`}
                    label="Account type"
                    required
                    value={a.accountType}
                    onChange={(v) => upd({ accountType: v ?? "" })}
                    options={ASSET_ACCOUNT_TYPE_OPTIONS}
                    disabled={disabled}
                  />
                  <TextField path={`assets.${i}.financialInstitution`} label="Financial institution" value={a.financialInstitution} onChange={(v) => upd({ financialInstitution: v })} disabled={disabled} />
                  <TextField
                    path={`assets.${i}.accountNumber`}
                    label="Account number"
                    value={a.accountNumber}
                    onChange={(v) => upd({ accountNumber: v })}
                    placeholder={a.accountNumberLast4 ? `on file — ends in ${a.accountNumberLast4}` : undefined}
                    hint="Stored encrypted; displayed as last 4"
                    disabled={disabled}
                  />
                  <CurrencyField path={`assets.${i}.cashOrMarketValue`} label="Cash or market value" value={a.cashOrMarketValue} onChange={(v) => upd({ cashOrMarketValue: v })} disabled={disabled} />
                </FieldGrid>
              </GroupCard>
            );
          })}
          {errorFor("assets") ? (
            <p role="alert" className="text-xs text-danger">{errorFor("assets")}</p>
          ) : null}
          <AddRowButton
            testId="assets-add"
            label="Add asset account"
            disabled={disabled}
            onClick={() => set({ assets: [...assets, { accountType: "", source: "manual" }] })}
          />
        </div>
      </div>

      <div>
        <SectionHeading sub="Other assets and credits (optional).">Other assets &amp; credits</SectionHeading>
        <div className="mt-3 space-y-4">
          {credits.map((c, i) => {
            const upd = (patch: Partial<typeof c>) => {
              const next = [...credits];
              next[i] = { ...c, ...patch };
              set({ otherCredits: next });
            };
            return (
              <GroupCard
                key={c.id ?? i}
                title={`Other asset / credit ${i + 1}`}
                disabled={disabled}
                onRemove={() => set({ otherCredits: credits.filter((_, j) => j !== i) })}
                removeTestId={`otherCredits-remove-${i}`}
              >
                <FieldGrid>
                  <SelectField
                    path={`otherCredits.${i}.type`}
                    label="Type"
                    required
                    value={c.type}
                    onChange={(v) => upd({ type: v ?? "" })}
                    options={OTHER_CREDIT_TYPE_OPTIONS}
                    disabled={disabled}
                  />
                  <TextField path={`otherCredits.${i}.sourceOrDonor`} label="Source / donor" value={c.sourceOrDonor} onChange={(v) => upd({ sourceOrDonor: v })} disabled={disabled} />
                  <CurrencyField path={`otherCredits.${i}.value`} label="Value" value={c.value} onChange={(v) => upd({ value: v })} disabled={disabled} />
                </FieldGrid>
              </GroupCard>
            );
          })}
          <AddRowButton
            testId="otherCredits-add"
            label="Add other asset or credit"
            disabled={disabled}
            onClick={() => set({ otherCredits: [...credits, { type: "" }] })}
          />
        </div>
      </div>

      <div>
        <SectionHeading sub="Required if declaration A.1 is Yes or Step 6 occupancy is not primary residence.">
          Real estate owned
        </SectionHeading>
        <div className="mt-3 space-y-4">
          {reo.map((r, i) => {
            const upd = (patch: Partial<typeof r>) => {
              const next = [...reo];
              next[i] = { ...r, ...patch };
              set({ realEstateOwned: next });
            };
            const mortgages = r.mortgages ?? [];
            return (
              <GroupCard
                key={r.id ?? i}
                title={`Property ${i + 1}`}
                disabled={disabled}
                onRemove={() => set({ realEstateOwned: reo.filter((_, j) => j !== i) })}
                removeTestId={`realEstateOwned-remove-${i}`}
              >
                <AddressGroup
                  basePath={`realEstateOwned.${i}.address`}
                  label="Property address"
                  required
                  value={r.address}
                  onChange={(a) => upd({ address: a })}
                  disabled={disabled}
                  errorFor={errorFor}
                />
                <FieldGrid>
                  <CurrencyField path={`realEstateOwned.${i}.propertyValue`} label="Property value" value={r.propertyValue} onChange={(v) => upd({ propertyValue: v })} disabled={disabled} />
                  <SelectField path={`realEstateOwned.${i}.status`} label="Status" value={r.status} onChange={(v) => upd({ status: v })} options={REO_STATUS_OPTIONS} disabled={disabled} />
                  <SelectField path={`realEstateOwned.${i}.intendedOccupancy`} label="Intended occupancy" value={r.intendedOccupancy} onChange={(v) => upd({ intendedOccupancy: v })} options={OCCUPANCY_TYPE_OPTIONS} disabled={disabled} />
                  <CurrencyField path={`realEstateOwned.${i}.monthlyInsuranceTaxesHoa`} label="Monthly insurance / taxes / HOA" value={r.monthlyInsuranceTaxesHoa} onChange={(v) => upd({ monthlyInsuranceTaxesHoa: v })} disabled={disabled} />
                  <CurrencyField path={`realEstateOwned.${i}.monthlyRentalIncome`} label="Monthly rental income" value={r.monthlyRentalIncome} onChange={(v) => upd({ monthlyRentalIncome: v })} disabled={disabled} />
                  <CurrencyField path={`realEstateOwned.${i}.netMonthlyRentalIncome`} label="Net monthly rental income" value={r.netMonthlyRentalIncome} onChange={(v) => upd({ netMonthlyRentalIncome: v })} disabled={disabled} />
                </FieldGrid>
                <div className="space-y-3">
                  <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">
                    Mortgage loans on this property
                  </p>
                  {mortgages.map((m, j) => {
                    const updM = (patch: Partial<typeof m>) => {
                      const nextM = [...mortgages];
                      nextM[j] = { ...m, ...patch };
                      upd({ mortgages: nextM });
                    };
                    return (
                      <div key={j} className="rounded-md border border-line bg-card p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-semibold text-ink-soft">Mortgage {j + 1}</p>
                          <button
                            type="button"
                            data-testid={`realEstateOwned-${i}-mortgages-remove-${j}`}
                            onClick={() => upd({ mortgages: mortgages.filter((_, k) => k !== j) })}
                            disabled={disabled}
                            className="text-xs font-semibold text-danger hover:opacity-70 disabled:opacity-40"
                          >
                            Remove
                          </button>
                        </div>
                        <FieldGrid>
                          <TextField path={`realEstateOwned.${i}.mortgages.${j}.creditor`} label="Creditor" required value={m.creditor} onChange={(v) => updM({ creditor: v })} disabled={disabled} />
                          <TextField
                            path={`realEstateOwned.${i}.mortgages.${j}.accountNumber`}
                            label="Account number"
                            value={m.accountNumber}
                            onChange={(v) => updM({ accountNumber: v })}
                            placeholder={m.accountNumberLast4 ? `on file — ends in ${m.accountNumberLast4}` : undefined}
                            hint="Shown as last 4"
                            disabled={disabled}
                          />
                          <CurrencyField path={`realEstateOwned.${i}.mortgages.${j}.monthlyPayment`} label="Monthly payment" value={m.monthlyPayment} onChange={(v) => updM({ monthlyPayment: v })} disabled={disabled} />
                          <CurrencyField path={`realEstateOwned.${i}.mortgages.${j}.unpaidBalance`} label="Unpaid balance" value={m.unpaidBalance} onChange={(v) => updM({ unpaidBalance: v })} disabled={disabled} />
                          <SelectField path={`realEstateOwned.${i}.mortgages.${j}.mortgageType`} label="Type" value={m.mortgageType} onChange={(v) => updM({ mortgageType: v })} options={LOAN_TYPE_OPTIONS} disabled={disabled} />
                        </FieldGrid>
                        <div className="mt-3">
                          <CheckField
                            path={`realEstateOwned.${i}.mortgages.${j}.paidOffAtClosing`}
                            label="To be paid off at or before closing"
                            checked={m.paidOffAtClosing === true}
                            onChange={(v) => updM({ paidOffAtClosing: v })}
                            disabled={disabled}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <AddRowButton
                    testId={`realEstateOwned-${i}-mortgages-add`}
                    label="Add mortgage"
                    disabled={disabled}
                    onClick={() => upd({ mortgages: [...mortgages, { creditor: "" }] })}
                  />
                </div>
              </GroupCard>
            );
          })}
          {errorFor("realEstateOwned") ? (
            <p role="alert" className="text-xs text-danger">{errorFor("realEstateOwned")}</p>
          ) : null}
          <AddRowButton
            testId="realEstateOwned-add"
            label="Add real estate owned"
            disabled={disabled}
            onClick={() => set({ realEstateOwned: [...reo, { address: { ...EMPTY_ADDRESS } }] })}
          />
        </div>
      </div>
    </div>
  );
}
