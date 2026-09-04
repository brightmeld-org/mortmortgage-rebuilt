"use client";

// Pre-qualification calculator client (task-018, REQ-043). Recalculates on
// EVERY input change via a debounced POST /api/public/prequalify (the §E math
// is server-side — the UI never re-implements it). Outputs and the qualify
// indicator render the contract PrequalifyResponse verbatim; server error
// bodies are surfaced verbatim. Selector contract (build-plan §C PublicTools):
// prequal-input-{field} / prequal-output-{metric} / prequal-qualify-indicator /
// start-application-btn.

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/components/auth/api";
import { fmtCurrency, fmtInputAmount, fmtRate, parseAmount } from "@/components/public-tools/format";
import { startApplicationWithNumbers } from "@/components/public-tools/handoff";

/** contracts.md §A PrequalifyResponse — client mirror (exact field names). */
interface PrequalifyResponse {
  maxLoanAmount: number;
  estimatedRate: number;
  estimatedMonthlyPiti: number;
  maxPurchasePrice: number;
  qualifyIndicator: "likely-to-qualify" | "review-needed";
}

/** contracts.json enums.CreditTier literals with §4.3.1 band labels. */
const CREDIT_TIER_OPTIONS = [
  { value: "excellent", label: "Excellent (≥ 740)" },
  { value: "good", label: "Good (700–739)" },
  { value: "fair", label: "Fair (660–699)" },
  { value: "poor", label: "Poor (< 660)" },
] as const;

type CreditTier = (typeof CREDIT_TIER_OPTIONS)[number]["value"];

const TERM_OPTIONS = [15, 20, 30] as const;

const DEBOUNCE_MS = 300;

interface FormState {
  grossMonthlyIncome: number | null;
  monthlyDebtPayments: number | null;
  creditTier: CreditTier;
  downPaymentAmount: number | null;
  termYears: number;
  propertyTaxRatePct: string; // free-typed decimal, default shown
  annualInsurance: number | null;
}

const INITIAL: FormState = {
  grossMonthlyIncome: 8_400,
  monthlyDebtPayments: 650,
  creditTier: "excellent",
  downPaymentAmount: 60_000,
  termYears: 30,
  propertyTaxRatePct: "1.2",
  annualInsurance: 1_200,
};

const fieldClass =
  "w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink outline-none transition-colors duration-200 focus:border-navy focus:ring-2 focus:ring-navy/15";
const labelClass = "mb-1.5 block text-xs font-semibold text-ink-soft";

export function PreQualifyClient() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [result, setResult] = useState<PrequalifyResponse | null>(null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [ctaError, setCtaError] = useState<string | null>(null);
  const [ctaBusy, setCtaBusy] = useState(false);
  const requestSeq = useRef(0);

  // Live recalculation: debounced server call on EVERY input change (REQ-043).
  useEffect(() => {
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      const taxRate = form.propertyTaxRatePct.trim() === "" ? undefined : Number(form.propertyTaxRatePct);
      const body = {
        grossMonthlyIncome: form.grossMonthlyIncome ?? 0,
        monthlyDebtPayments: form.monthlyDebtPayments ?? 0,
        creditTier: form.creditTier,
        downPaymentAmount: form.downPaymentAmount ?? 0,
        termYears: form.termYears,
        ...(taxRate !== undefined && Number.isFinite(taxRate) ? { propertyTaxRatePct: taxRate } : {}),
        ...(form.annualInsurance !== null ? { annualInsurance: form.annualInsurance } : {}),
      };
      const response = await postJson<PrequalifyResponse>("/api/public/prequalify", body);
      if (seq !== requestSeq.current) return; // stale response — a newer edit is in flight
      if (response.ok) {
        setResult(response.data);
        setError(null);
      } else {
        // Server message + details verbatim (NFR-025).
        setError({ message: response.error.message, details: response.error.details ?? [] });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [form]);

  const setAmount = (key: "grossMonthlyIncome" | "monthlyDebtPayments" | "downPaymentAmount" | "annualInsurance") =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: parseAmount(e.target.value) }));

  const onStartApplication = async () => {
    setCtaBusy(true);
    setCtaError(null);
    const outcome = await startApplicationWithNumbers({
      ...(form.grossMonthlyIncome !== null ? { grossMonthlyIncome: form.grossMonthlyIncome } : {}),
      ...(form.monthlyDebtPayments !== null ? { monthlyDebtPayments: form.monthlyDebtPayments } : {}),
      ...(form.downPaymentAmount !== null ? { downPaymentAmount: form.downPaymentAmount } : {}),
      termMonths: form.termYears * 12,
      // Carry the estimate into Step 7 (REQ-045 "loan amount/rate"): the max
      // loan the calculator produced and its tier rate. Conventional is the
      // calculator's pricing basis (§E tier rate = conventional base table).
      ...(result && result.maxLoanAmount > 0 ? { loanAmount: result.maxLoanAmount } : {}),
      ...(result ? { interestRate: result.estimatedRate } : {}),
      loanType: "conventional",
    });
    if (!outcome.ok) {
      setCtaError(outcome.message);
      setCtaBusy(false);
    }
    // On success the helper navigates to /sign-in — leave the button busy.
  };

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_20rem]">
      {/* ---- Input form (left) ---- */}
      <section aria-label="Calculator inputs" className="rounded-lg border border-line bg-card p-6 shadow-sm">
        {error && (
          <div role="alert" data-testid="prequal-error-banner" className="mb-5 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
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
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="pq-income" className={labelClass}>Gross monthly income</label>
            <input
              id="pq-income"
              data-testid="prequal-input-grossMonthlyIncome"
              inputMode="decimal"
              className={fieldClass}
              value={form.grossMonthlyIncome === null ? "" : `$${fmtInputAmount(form.grossMonthlyIncome)}`}
              onChange={setAmount("grossMonthlyIncome")}
            />
          </div>
          <div>
            <label htmlFor="pq-debts" className={labelClass}>Existing monthly debt payments</label>
            <input
              id="pq-debts"
              data-testid="prequal-input-monthlyDebtPayments"
              inputMode="decimal"
              className={fieldClass}
              value={form.monthlyDebtPayments === null ? "" : `$${fmtInputAmount(form.monthlyDebtPayments)}`}
              onChange={setAmount("monthlyDebtPayments")}
            />
          </div>
          <div>
            <label htmlFor="pq-tier" className={labelClass}>Credit tier</label>
            <select
              id="pq-tier"
              data-testid="prequal-input-creditTier"
              className={fieldClass}
              value={form.creditTier}
              onChange={(e) => setForm((f) => ({ ...f, creditTier: e.target.value as CreditTier }))}
            >
              {CREDIT_TIER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pq-down" className={labelClass}>Down payment</label>
            <input
              id="pq-down"
              data-testid="prequal-input-downPaymentAmount"
              inputMode="decimal"
              className={fieldClass}
              value={form.downPaymentAmount === null ? "" : `$${fmtInputAmount(form.downPaymentAmount)}`}
              onChange={setAmount("downPaymentAmount")}
            />
          </div>
          <div>
            <label htmlFor="pq-term" className={labelClass}>Loan term</label>
            <select
              id="pq-term"
              data-testid="prequal-input-termYears"
              className={fieldClass}
              value={form.termYears}
              onChange={(e) => setForm((f) => ({ ...f, termYears: Number(e.target.value) }))}
            >
              {TERM_OPTIONS.map((t) => (
                <option key={t} value={t}>{t} years</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pq-tax" className={labelClass}>Property tax rate</label>
            <div className="relative">
              <input
                id="pq-tax"
                data-testid="prequal-input-propertyTaxRatePct"
                inputMode="decimal"
                className={`${fieldClass} pr-14`}
                value={form.propertyTaxRatePct}
                onChange={(e) => setForm((f) => ({ ...f, propertyTaxRatePct: e.target.value.replace(/[^0-9.]/g, "") }))}
              />
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">% / yr</span>
            </div>
            {form.propertyTaxRatePct === "1.2" && <p className="mt-1 text-xs text-muted">default</p>}
          </div>
          <div>
            <label htmlFor="pq-ins" className={labelClass}>Homeowner&rsquo;s insurance</label>
            <div className="relative">
              <input
                id="pq-ins"
                data-testid="prequal-input-annualInsurance"
                inputMode="decimal"
                className={`${fieldClass} pr-12`}
                value={form.annualInsurance === null ? "" : `$${fmtInputAmount(form.annualInsurance)}`}
                onChange={setAmount("annualInsurance")}
              />
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">/ yr</span>
            </div>
            {form.annualInsurance === 1_200 && <p className="mt-1 text-xs text-muted">default</p>}
          </div>
        </div>
      </section>

      {/* ---- Live results panel (right) ---- */}
      <div className="space-y-5">
        <section
          aria-label="Your estimate"
          aria-live="polite"
          className="rounded-lg border border-line border-t-4 border-t-copper bg-card p-5 shadow-sm"
        >
          <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-soft">Your estimate</h2>
          <dl className="mt-3 divide-y divide-line/70 text-sm">
            <div className="flex items-baseline justify-between gap-3 py-2.5">
              <dt className="text-ink-soft">Maximum loan (43% DTI)</dt>
              <dd data-testid="prequal-output-maxLoanAmount" className="font-semibold text-ink">
                {result ? fmtCurrency(result.maxLoanAmount) : "—"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-2.5">
              <dt className="text-ink-soft">Estimated rate</dt>
              <dd data-testid="prequal-output-estimatedRate" className="font-semibold text-ink">
                {result ? fmtRate(result.estimatedRate) : "—"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-2.5">
              <dt className="text-ink-soft">Est. monthly PITI</dt>
              <dd data-testid="prequal-output-estimatedMonthlyPiti" className="font-semibold text-ink">
                {result ? fmtCurrency(result.estimatedMonthlyPiti) : "—"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-2.5">
              <dt className="text-ink-soft">Max purchase price</dt>
              <dd data-testid="prequal-output-maxPurchasePrice" className="font-semibold text-ink">
                {result ? fmtCurrency(result.maxPurchasePrice) : "—"}
              </dd>
            </div>
          </dl>
          {result && (
            <p
              data-testid="prequal-qualify-indicator"
              data-indicator={result.qualifyIndicator}
              className={`mt-3 inline-block rounded-full px-3 py-1 text-xs font-semibold ${
                result.qualifyIndicator === "likely-to-qualify"
                  ? "bg-success-soft text-success"
                  : "bg-warn-soft text-warn"
              }`}
            >
              {result.qualifyIndicator === "likely-to-qualify" ? "Likely to qualify" : "Review needed"}
            </p>
          )}
        </section>

        <section aria-label="Start an application" className="rounded-lg border border-line bg-card p-5 shadow-sm">
          <p className="text-sm text-ink-soft">
            Carry these numbers into a new application. You&rsquo;ll sign in or register first.
          </p>
          {ctaError && (
            <p role="alert" className="mt-2 text-sm text-danger">{ctaError}</p>
          )}
          <button
            type="button"
            data-testid="start-application-btn"
            disabled={ctaBusy}
            onClick={onStartApplication}
            className="mt-3 w-full rounded-md bg-copper px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy disabled:cursor-not-allowed disabled:opacity-60"
          >
            {ctaBusy ? "Preparing…" : "Start an application with these numbers"}
          </button>
        </section>
      </div>
    </div>
  );
}
