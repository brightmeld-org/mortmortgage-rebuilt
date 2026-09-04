"use client";

// UrlaWizard (task-016) — Step 9: Demographic Information (HMDA, per borrower,
// §4.2.4). Each item optional; "I do not wish to provide this information"
// offered for each. Race is multi-select with sub-options and free-text detail
// for tribe / Other Asian / Other Pacific Islander; ethnicity offers Hispanic
// sub-options with Other free text. Collection method is system-set to
// Email/Internet (DATA-003) — displayed, not editable.

import type { Demographics } from "../types";
import {
  ETHNICITY_HISPANIC_SUBOPTIONS,
  ETHNICITY_ROOT_OPTIONS,
  RACE_ASIAN_SUBOPTIONS,
  RACE_PACIFIC_SUBOPTIONS,
  RACE_ROOT_OPTIONS,
  SEX_OPTIONS,
} from "../types";
import { SectionHeading, TextField, inputClass } from "../fields";

function toggleValue(list: string[] | undefined, value: string, on: boolean): string[] {
  const set = new Set(list ?? []);
  if (on) set.add(value);
  else set.delete(value);
  return Array.from(set);
}

function CheckRow({
  testId,
  label,
  checked,
  onChange,
  disabled,
  indent,
}: {
  testId: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  indent?: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-center gap-2 text-sm text-ink ${indent ? "ml-6" : ""}`}>
      <input
        data-testid={testId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 accent-navy"
      />
      {label}
    </label>
  );
}

export function Step9Demographics({
  data,
  onChange,
  disabled,
  errorFor,
}: {
  data: Demographics;
  onChange: (next: Demographics) => void;
  disabled: boolean;
  errorFor: (path: string) => string | undefined;
}) {
  const set = (patch: Partial<Demographics>) => onChange({ ...data, ...patch });
  const ethnicity = data.ethnicity ?? [];
  const race = data.race ?? [];
  const raceDetails = data.raceOtherDetails ?? [];

  const setEthnicity = (value: string, on: boolean) =>
    set({ ethnicity: toggleValue(ethnicity, value, on) });
  const setRace = (value: string, on: boolean) => set({ race: toggleValue(race, value, on) });

  // raceOtherDetails free-text slots: 0 = tribe, 1 = other Asian, 2 = other Pacific Islander.
  const setRaceDetail = (slot: number, text: string) => {
    const next = [...raceDetails];
    while (next.length <= slot) next.push("");
    next[slot] = text;
    set({ raceOtherDetails: next });
  };

  return (
    <div className="space-y-8">
      <p className="rounded-lg border border-info/30 bg-info-soft p-4 text-sm text-ink-soft">
        The federal government requests this information to monitor compliance with equal credit
        opportunity and fair housing laws. You are not required to provide it — each item offers
        &ldquo;I do not wish to provide this information.&rdquo; Your answers do not affect your
        application.
      </p>

      <div data-testid="field-ethnicity" role="group" aria-label="Ethnicity">
        <SectionHeading>Ethnicity</SectionHeading>
        {errorFor("ethnicity") ? (
          <p role="alert" className="mt-1 text-xs text-danger">{errorFor("ethnicity")}</p>
        ) : null}
        <div className="mt-3 space-y-2">
          {ETHNICITY_ROOT_OPTIONS.map((o) => (
            <div key={o.value} className="space-y-2">
              <CheckRow
                testId={`field-ethnicity-${o.value}`}
                label={o.label}
                checked={ethnicity.includes(o.value)}
                onChange={(v) => setEthnicity(o.value, v)}
                disabled={disabled}
              />
              {o.value === "hispanic-or-latino" && ethnicity.includes("hispanic-or-latino") ? (
                <div className="space-y-2">
                  {ETHNICITY_HISPANIC_SUBOPTIONS.map((s) => (
                    <CheckRow
                      key={s.value}
                      testId={`field-ethnicity-${s.value}`}
                      label={s.label}
                      checked={ethnicity.includes(s.value)}
                      onChange={(v) => setEthnicity(s.value, v)}
                      disabled={disabled}
                      indent
                    />
                  ))}
                  {ethnicity.includes("other-hispanic-or-latino") ? (
                    <div className="ml-6 max-w-sm">
                      <TextField
                        path="ethnicityOtherDetail"
                        label="Other Hispanic or Latino — print origin"
                        value={data.ethnicityOtherDetail}
                        onChange={(v) => set({ ethnicityOtherDetail: v })}
                        disabled={disabled}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div data-testid="field-race" role="group" aria-label="Race">
        <SectionHeading sub="Select all that apply.">Race</SectionHeading>
        {errorFor("race") ? (
          <p role="alert" className="mt-1 text-xs text-danger">{errorFor("race")}</p>
        ) : null}
        <div className="mt-3 space-y-2">
          {RACE_ROOT_OPTIONS.map((o) => (
            <div key={o.value} className="space-y-2">
              <CheckRow
                testId={`field-race-${o.value}`}
                label={o.label}
                checked={race.includes(o.value)}
                onChange={(v) => setRace(o.value, v)}
                disabled={disabled}
              />
              {o.value === "american-indian-or-alaska-native" &&
              race.includes("american-indian-or-alaska-native") ? (
                <div className="ml-6 max-w-sm">
                  <label className="mb-1 block text-[13px] font-semibold text-ink">
                    Enrolled or principal tribe
                  </label>
                  <input
                    data-testid="field-raceOtherDetails-0"
                    type="text"
                    value={raceDetails[0] ?? ""}
                    onChange={(e) => setRaceDetail(0, e.target.value)}
                    disabled={disabled}
                    className={inputClass}
                  />
                </div>
              ) : null}
              {o.value === "asian" && race.includes("asian") ? (
                <div className="space-y-2">
                  {RACE_ASIAN_SUBOPTIONS.map((s) => (
                    <CheckRow
                      key={s.value}
                      testId={`field-race-${s.value}`}
                      label={s.label}
                      checked={race.includes(s.value)}
                      onChange={(v) => setRace(s.value, v)}
                      disabled={disabled}
                      indent
                    />
                  ))}
                  {race.includes("other-asian") ? (
                    <div className="ml-6 max-w-sm">
                      <label className="mb-1 block text-[13px] font-semibold text-ink">
                        Other Asian — print race
                      </label>
                      <input
                        data-testid="field-raceOtherDetails-1"
                        type="text"
                        value={raceDetails[1] ?? ""}
                        onChange={(e) => setRaceDetail(1, e.target.value)}
                        disabled={disabled}
                        className={inputClass}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {o.value === "native-hawaiian-or-pacific-islander" &&
              race.includes("native-hawaiian-or-pacific-islander") ? (
                <div className="space-y-2">
                  {RACE_PACIFIC_SUBOPTIONS.map((s) => (
                    <CheckRow
                      key={s.value}
                      testId={`field-race-${s.value}`}
                      label={s.label}
                      checked={race.includes(s.value)}
                      onChange={(v) => setRace(s.value, v)}
                      disabled={disabled}
                      indent
                    />
                  ))}
                  {race.includes("other-pacific-islander") ? (
                    <div className="ml-6 max-w-sm">
                      <label className="mb-1 block text-[13px] font-semibold text-ink">
                        Other Pacific Islander — print race
                      </label>
                      <input
                        data-testid="field-raceOtherDetails-2"
                        type="text"
                        value={raceDetails[2] ?? ""}
                        onChange={(e) => setRaceDetail(2, e.target.value)}
                        disabled={disabled}
                        className={inputClass}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div data-testid="field-sex" role="group" aria-label="Sex">
        <SectionHeading>Sex</SectionHeading>
        {errorFor("sex") ? (
          <p role="alert" className="mt-1 text-xs text-danger">{errorFor("sex")}</p>
        ) : null}
        <div className="mt-3 space-y-2">
          {SEX_OPTIONS.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                data-testid={`field-sex-${o.value}`}
                type="radio"
                name="sex"
                checked={data.sex === o.value}
                onChange={() => set({ sex: o.value })}
                disabled={disabled}
                className="h-4 w-4 accent-navy"
              />
              {o.label}
            </label>
          ))}
        </div>
      </div>

      <div data-testid="field-collectionMethod" className="rounded-lg border border-line bg-paper/50 p-4 text-sm text-ink-soft">
        <p>
          <span className="font-semibold text-ink">Collection method:</span> Email or Internet
          (system-set). Collected on the basis of visual observation or surname:{" "}
          <span className="font-semibold text-ink">No</span>.
        </p>
      </div>
    </div>
  );
}
