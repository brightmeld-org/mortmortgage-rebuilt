"use client";

// UrlaWizard (task-016) — Step 8: Declarations (per borrower). All fifteen
// answers required, wording EXACTLY as §4.2.4 Step 8 (A–M), with conditional
// detail inputs (A.1 property type + title held; C amount; M bankruptcy type).

import type { Declarations } from "../types";
import { BANKRUPTCY_TYPE_OPTIONS, TITLE_HELD_TYPE_OPTIONS } from "../types";
import { CurrencyField, FieldGrid, SelectField, YesNoField } from "../fields";

// §4.2.4 Step 8 — exact wording (do not paraphrase).
const A1_PROPERTY_TYPE_OPTIONS = [
  { value: "primary-residence", label: "Primary residence" },
  { value: "second-home", label: "Second home" },
  { value: "investment-property", label: "Investment" },
];

export function Step8Declarations({
  data,
  onChange,
  disabled,
  errorFor,
}: {
  data: Declarations;
  onChange: (next: Declarations) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
}) {
  const set = (patch: Partial<Declarations>) => onChange({ ...data, ...patch });

  const row = (
    key: keyof Declarations,
    letter: string,
    wording: string,
    extra?: React.ReactNode,
  ) => (
    <div className="rounded-lg border border-line bg-paper/50 p-4">
      <YesNoField
        path={key as string}
        label={
          <>
            <span className="mr-2 font-display font-semibold text-copper">{letter}.</span>
            {wording}
          </>
        }
        required
        value={data[key] as boolean | undefined}
        onChange={(v) => set({ [key]: v } as Partial<Declarations>)}
        disabled={disabled}
        error={errorFor(key as string)}
      />
      {extra ? <div className="mt-4 border-t border-line pt-4">{extra}</div> : null}
    </div>
  );

  return (
    <div className="space-y-4">
      {row("aOccupyPrimary", "A", "Will you occupy the property as your primary residence?")}
      {row(
        "a1PriorOwnership",
        "A.1",
        "Have you had an ownership interest in another property in the last three years?",
        data.a1PriorOwnership === true ? (
          <FieldGrid cols={2}>
            <SelectField
              path="a1PropertyType"
              label="What type of property did you own?"
              required
              value={data.a1PropertyType}
              onChange={(v) => set({ a1PropertyType: v })}
              options={A1_PROPERTY_TYPE_OPTIONS}
              disabled={disabled}
              error={errorFor("a1PropertyType")}
            />
            <SelectField
              path="a1TitleHeld"
              label="How did you hold title to the property?"
              required
              value={data.a1TitleHeld}
              onChange={(v) => set({ a1TitleHeld: v })}
              options={TITLE_HELD_TYPE_OPTIONS}
              disabled={disabled}
              error={errorFor("a1TitleHeld")}
            />
          </FieldGrid>
        ) : undefined,
      )}
      {row("bSellerRelationship", "B", "Do you have a family relationship or business affiliation with the seller of the property?")}
      {row(
        "cUndisclosedBorrowing",
        "C",
        "Are you borrowing any money for this real estate transaction or obtaining any money from another party that you have not disclosed?",
        data.cUndisclosedBorrowing === true ? (
          <FieldGrid cols={2}>
            <CurrencyField
              path="cAmount"
              label="What is the amount of this money?"
              required
              value={data.cAmount}
              onChange={(v) => set({ cAmount: v })}
              disabled={disabled}
              error={errorFor("cAmount")}
            />
          </FieldGrid>
        ) : undefined,
      )}
      {row("d1OtherMortgageApplication", "D.1", "Have you or will you be applying for a mortgage loan on another property on or before closing that is not disclosed on this application?")}
      {row("d2NewCreditApplication", "D.2", "Have you or will you be applying for any new credit on or before closing that is not disclosed on this application?")}
      {row("ePriorityLien", "E", "Will this property be subject to a lien that could take priority over the first mortgage lien, such as a clean-energy lien paid through property taxes?")}
      {row("fCosignerUndisclosed", "F", "Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?")}
      {row("gOutstandingJudgments", "G", "Are there any outstanding judgments against you?")}
      {row("hFederalDebtDelinquent", "H", "Are you currently delinquent or in default on a federal debt?")}
      {row("iPartyToLawsuit", "I", "Are you a party to a lawsuit in which you potentially have any personal financial liability?")}
      {row("jConveyedTitleInLieu", "J", "Have you conveyed title to any property in lieu of foreclosure in the past 7 years?")}
      {row("kPreForeclosureSale", "K", "Within the past 7 years, have you completed a pre-foreclosure sale or short sale?")}
      {row("lForeclosed", "L", "Have you had property foreclosed upon in the last 7 years?")}
      {row(
        "mBankruptcy",
        "M",
        "Have you declared bankruptcy within the past 7 years?",
        data.mBankruptcy === true ? (
          <FieldGrid cols={2}>
            <SelectField
              path="mBankruptcyType"
              label="Bankruptcy type"
              required
              value={data.mBankruptcyType}
              onChange={(v) => set({ mBankruptcyType: v })}
              options={BANKRUPTCY_TYPE_OPTIONS}
              disabled={disabled}
              error={errorFor("mBankruptcyType")}
            />
          </FieldGrid>
        ) : undefined,
      )}
    </div>
  );
}
