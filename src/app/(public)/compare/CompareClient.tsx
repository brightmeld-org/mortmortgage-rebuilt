"use client";

// Loan-comparison client (task-018, REQ-044). Three scenario columns (contract
// floor), named presets, debounced POST /api/public/compare on every change —
// the §E math is server-side; the lowest-total-cost scenario returned with
// bestValue=true gets the highlight. Server error bodies surface verbatim.
// Selector contract (build-plan §C PublicTools): compare-scenario-{n}-{field} /
// compare-result-{n}-{metric} / compare-best-value / compare-preset-{name} /
// start-application-btn (1-based n).

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/components/auth/api";
import { fmtCurrency, fmtInputAmount, fmtLtv, parseAmount } from "@/components/public-tools/format";
import { startApplicationWithNumbers } from "@/components/public-tools/handoff";

/** contracts.json enums.LoanType — verbatim values, display labels. */
const LOAN_TYPE_OPTIONS = [
  { value: "conventional", label: "Conventional" },
  { value: "fha", label: "FHA" },
  { value: "va", label: "VA" },
  { value: "usda", label: "USDA" },
] as const;

type LoanType = (typeof LOAN_TYPE_OPTIONS)[number]["value"];

/** contracts.md §A CompareScenarioInput — exact field names. */
interface ScenarioInput {
  loanAmount: number;
  interestRate: number;
  termMonths: number;
  downPayment: number;
  loanType: LoanType;
}

/** contracts.md §A CompareScenarioResult — client mirror (exact field names). */
interface ScenarioResult {
  monthlyPrincipalInterest: number;
  monthlyPiti: number;
  totalInterest: number;
  ltv: number;
  totalCost: number;
  lifetimeMortgageInsurance?: number;
  bestValue: boolean;
}

const TERM_OPTIONS = [
  { months: 180, label: "15 yr" },
  { months: 240, label: "20 yr" },
  { months: 360, label: "30 yr" },
] as const;

/** Frame default state (screen-compare.png): 15/20/30-yr mix, third FHA. */
const DEFAULT_SCENARIOS: ScenarioInput[] = [
  { loanAmount: 360_000, interestRate: 5.85, termMonths: 180, downPayment: 90_000, loanType: "conventional" },
  { loanAmount: 360_000, interestRate: 6.25, termMonths: 240, downPayment: 90_000, loanType: "conventional" },
  { loanAmount: 360_000, interestRate: 6.15, termMonths: 360, downPayment: 90_000, loanType: "fha" },
];

/** §4.3.2 named presets. Rates follow the §6.3.4 base table for each column. */
const PRESETS: { name: string; label: string; scenarios: ScenarioInput[] }[] = [
  {
    name: "15-vs-30-year",
    label: "15 vs 30 year",
    scenarios: [
      { loanAmount: 360_000, interestRate: 5.85, termMonths: 180, downPayment: 90_000, loanType: "conventional" },
      { loanAmount: 360_000, interestRate: 6.25, termMonths: 240, downPayment: 90_000, loanType: "conventional" },
      { loanAmount: 360_000, interestRate: 6.5, termMonths: 360, downPayment: 90_000, loanType: "conventional" },
    ],
  },
  {
    name: "5-vs-20-down",
    label: "5% vs 20% down",
    scenarios: [
      { loanAmount: 427_500, interestRate: 6.5, termMonths: 360, downPayment: 22_500, loanType: "conventional" },
      { loanAmount: 405_000, interestRate: 6.5, termMonths: 360, downPayment: 45_000, loanType: "conventional" },
      { loanAmount: 360_000, interestRate: 6.5, termMonths: 360, downPayment: 90_000, loanType: "conventional" },
    ],
  },
  {
    name: "conventional-vs-fha",
    label: "Conventional vs FHA",
    scenarios: [
      { loanAmount: 360_000, interestRate: 6.5, termMonths: 360, downPayment: 90_000, loanType: "conventional" },
      { loanAmount: 360_000, interestRate: 6.15, termMonths: 360, downPayment: 90_000, loanType: "fha" },
      { loanAmount: 360_000, interestRate: 6.05, termMonths: 360, downPayment: 90_000, loanType: "va" },
    ],
  },
];

const SCENARIO_LETTERS = ["A", "B", "C", "D"];
const DEBOUNCE_MS = 300;

const fieldClass =
  "w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink outline-none transition-colors duration-200 focus:border-navy focus:ring-2 focus:ring-navy/15";
const labelClass = "mb-1 block text-xs font-semibold text-ink-soft";

export function CompareClient() {
  const [scenarios, setScenarios] = useState<ScenarioInput[]>(DEFAULT_SCENARIOS);
  const [activePreset, setActivePreset] = useState<string | null>("15-vs-30-year");
  const [results, setResults] = useState<ScenarioResult[] | null>(null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [ctaError, setCtaError] = useState<string | null>(null);
  const [ctaBusy, setCtaBusy] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      const response = await postJson<{ scenarios: ScenarioResult[] }>("/api/public/compare", { scenarios });
      if (seq !== requestSeq.current) return;
      if (response.ok) {
        setResults(response.data.scenarios);
        setError(null);
      } else {
        setError({ message: response.error.message, details: response.error.details ?? [] });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [scenarios]);

  const update = (index: number, patch: Partial<ScenarioInput>) => {
    setActivePreset(null);
    setScenarios((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setActivePreset(preset.name);
    setScenarios(preset.scenarios.map((s) => ({ ...s })));
  };

  const onStartApplication = async () => {
    setCtaBusy(true);
    setCtaError(null);
    // Carry the best-value scenario's numbers (fallback: first scenario).
    const bestIndex = results ? results.findIndex((r) => r.bestValue) : 0;
    const best = scenarios[bestIndex >= 0 ? bestIndex : 0]!;
    const outcome = await startApplicationWithNumbers({
      loanAmount: best.loanAmount,
      interestRate: best.interestRate,
      termMonths: best.termMonths,
      downPaymentAmount: best.downPayment,
      loanType: best.loanType,
    });
    if (!outcome.ok) {
      setCtaError(outcome.message);
      setCtaBusy(false);
    }
  };

  return (
    <div className="mt-6">
      {/* ---- Preset chips ---- */}
      <div role="group" aria-label="Comparison presets" className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => {
          const active = activePreset === preset.name;
          return (
            <button
              key={preset.name}
              type="button"
              data-testid={`compare-preset-${preset.name}`}
              aria-pressed={active}
              onClick={() => applyPreset(preset)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors duration-200 ${
                active
                  ? "bg-navy-deep text-white"
                  : "border border-line bg-card text-ink-soft hover:border-navy hover:text-navy"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div role="alert" data-testid="compare-error-banner" className="mt-5 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          <p className="font-semibold">{error.message}</p>
          {error.details.length > 0 && (
            <ul className="mt-1 list-inside list-disc">
              {error.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---- Scenario columns (horizontal scroll on mobile) ---- */}
      <div className="mt-5 overflow-x-auto pb-2">
        <div className="grid min-w-[54rem] grid-cols-3 gap-5">
          {scenarios.map((scenario, i) => {
            const n = i + 1;
            const result = results?.[i] ?? null;
            const best = result?.bestValue === true;
            return (
              <section
                key={n}
                aria-label={`Scenario ${SCENARIO_LETTERS[i]}`}
                data-testid={`compare-scenario-${n}`}
                className={`relative rounded-lg border bg-card p-5 shadow-sm transition-colors duration-200 ${
                  best ? "border-copper ring-1 ring-copper" : "border-line"
                }`}
              >
                {best && (
                  <span
                    data-testid="compare-best-value"
                    className="absolute -top-3 left-4 rounded-full bg-copper-soft px-2.5 py-0.5 text-xs font-bold text-copper"
                  >
                    Best value
                  </span>
                )}
                <h2 className="font-display text-lg font-semibold text-ink">Scenario {SCENARIO_LETTERS[i]}</h2>

                <div className="mt-3 space-y-3">
                  <div>
                    <label htmlFor={`cmp-${n}-loan`} className={labelClass}>Loan amount</label>
                    <input
                      id={`cmp-${n}-loan`}
                      data-testid={`compare-scenario-${n}-loanAmount`}
                      inputMode="decimal"
                      className={fieldClass}
                      value={`$${fmtInputAmount(scenario.loanAmount)}`}
                      onChange={(e) => update(i, { loanAmount: parseAmount(e.target.value) ?? 0 })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`cmp-${n}-rate`} className={labelClass}>Rate</label>
                      <div className="relative">
                        <input
                          id={`cmp-${n}-rate`}
                          data-testid={`compare-scenario-${n}-interestRate`}
                          inputMode="decimal"
                          className={`${fieldClass} pr-7`}
                          value={String(scenario.interestRate)}
                          onChange={(e) => {
                            const v = Number(e.target.value.replace(/[^0-9.]/g, ""));
                            update(i, { interestRate: Number.isFinite(v) ? v : 0 });
                          }}
                        />
                        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">%</span>
                      </div>
                    </div>
                    <div>
                      <label htmlFor={`cmp-${n}-term`} className={labelClass}>Term</label>
                      <select
                        id={`cmp-${n}-term`}
                        data-testid={`compare-scenario-${n}-termMonths`}
                        className={fieldClass}
                        value={scenario.termMonths}
                        onChange={(e) => update(i, { termMonths: Number(e.target.value) })}
                      >
                        {TERM_OPTIONS.map((t) => (
                          <option key={t.months} value={t.months}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`cmp-${n}-down`} className={labelClass}>Down payment</label>
                      <input
                        id={`cmp-${n}-down`}
                        data-testid={`compare-scenario-${n}-downPayment`}
                        inputMode="decimal"
                        className={fieldClass}
                        value={`$${fmtInputAmount(scenario.downPayment)}`}
                        onChange={(e) => update(i, { downPayment: parseAmount(e.target.value) ?? 0 })}
                      />
                    </div>
                    <div>
                      <label htmlFor={`cmp-${n}-type`} className={labelClass}>Type</label>
                      <select
                        id={`cmp-${n}-type`}
                        data-testid={`compare-scenario-${n}-loanType`}
                        className={fieldClass}
                        value={scenario.loanType}
                        onChange={(e) => update(i, { loanType: e.target.value as LoanType })}
                      >
                        {LOAN_TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <dl className="mt-4 divide-y divide-line/70 border-t border-line pt-1 text-sm" aria-live="polite">
                  <div className="flex items-baseline justify-between gap-2 py-2">
                    <dt className="text-ink-soft">Monthly P&amp;I</dt>
                    <dd data-testid={`compare-result-${n}-monthlyPrincipalInterest`} className="font-semibold text-ink">
                      {result ? fmtCurrency(result.monthlyPrincipalInterest) : "—"}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 py-2">
                    <dt className="text-ink-soft">
                      {scenario.loanType === "fha" || scenario.loanType === "usda"
                        ? "Monthly PITI (incl. MI)"
                        : "Monthly PITI"}
                    </dt>
                    <dd data-testid={`compare-result-${n}-monthlyPiti`} className="font-semibold text-ink">
                      {result ? fmtCurrency(result.monthlyPiti) : "—"}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 py-2">
                    <dt className="text-ink-soft">Total interest</dt>
                    <dd data-testid={`compare-result-${n}-totalInterest`} className="font-semibold text-ink">
                      {result ? fmtCurrency(result.totalInterest) : "—"}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 py-2">
                    <dt className="text-ink-soft">LTV</dt>
                    <dd data-testid={`compare-result-${n}-ltv`} className="font-semibold text-ink">
                      {result ? fmtLtv(result.ltv) : "—"}
                    </dd>
                  </div>
                  {result?.lifetimeMortgageInsurance !== undefined && (
                    <div className="flex items-baseline justify-between gap-2 py-2">
                      <dt className="text-ink-soft">Lifetime MI</dt>
                      <dd data-testid={`compare-result-${n}-lifetimeMortgageInsurance`} className="font-semibold text-ink">
                        {fmtCurrency(result.lifetimeMortgageInsurance)}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-2 py-2">
                    <dt className="text-ink-soft">Total cost of loan</dt>
                    <dd data-testid={`compare-result-${n}-totalCost`} className={`font-semibold ${best ? "text-copper" : "text-ink"}`}>
                      {result ? fmtCurrency(result.totalCost) : "—"}
                    </dd>
                  </div>
                </dl>
              </section>
            );
          })}
        </div>
      </div>

      {/* ---- CTA ---- */}
      <div className="mt-6">
        {ctaError && <p role="alert" className="mb-2 text-sm text-danger">{ctaError}</p>}
        <button
          type="button"
          data-testid="start-application-btn"
          disabled={ctaBusy}
          onClick={onStartApplication}
          className="rounded-md bg-copper px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy disabled:cursor-not-allowed disabled:opacity-60"
        >
          {ctaBusy ? "Preparing…" : "Start an application with these numbers"}
        </button>
      </div>
    </div>
  );
}
