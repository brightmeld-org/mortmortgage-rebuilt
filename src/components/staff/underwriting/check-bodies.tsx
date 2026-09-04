"use client";

// §4.6.5 displayed-result bodies for the credit / income / pricing / AUS
// checks (task-026). Every field rendered here is a contracts §A field —
// CreditCheckResult, IncomeCheckResult, PricingCheckResult, AusCheckResult —
// displayed with the shared app formats (Mon D, YYYY / $1,234.56).
// The AVM body (map + comparables + fallback) lives in AvmSection.tsx.

import { formatCurrency, formatDate, humanizeEnum } from "@/components/borrower/format";
import { MetricRow, MiniTable, SubHeading, Td } from "./ui";
import type {
  AusCheckResult,
  CreditCheckResult,
  IncomeCheckResult,
  PricingCheckResult,
} from "./types";

// ---------------------------------------------------------------------------
// Shared number formats
// ---------------------------------------------------------------------------

/** "22%" / "41.8%" — trims trailing zeros, keeps up to `digits` decimals. */
export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = Number(value.toFixed(digits));
  return `${rounded}%`;
}

/** Interest-rate style: always 3 decimals ("6.625%"). */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(3)}%`;
}

/** Signed points/credits ("1.0" / "−1.0" / "0"). */
function formatPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return String(Number(value.toFixed(3)));
}

const dash = "—";

// ---------------------------------------------------------------------------
// Credit (tri-bureau) — §4.6.5 row 1
// ---------------------------------------------------------------------------

export function CreditBody({ result }: { result: CreditCheckResult }) {
  return (
    <div>
      <SubHeading>Bureau scores</SubHeading>
      <MiniTable headers={["Bureau", "Score"]} caption="Bureau scores">
        {result.bureauScores.map((row) => (
          <tr key={row.bureau}>
            <Td>{row.bureau}</Td>
            <Td right>{row.unavailable ? "Unavailable" : (row.score ?? dash)}</Td>
          </tr>
        ))}
      </MiniTable>

      <div className="mt-3">
        <MetricRow label="Middle score used">{result.middleScore ?? dash}</MetricRow>
        <MetricRow label="Qualifying score (lower of borrowers)">
          {result.qualifyingScore ?? dash}
        </MetricRow>
        <MetricRow label="Risk tier (Good ≥ 700 / Fair 640–699 / Poor < 640)">
          {result.riskTier ? humanizeEnum(result.riskTier) : dash}
        </MetricRow>
        <MetricRow label="Total utilization">{formatPct(result.totalUtilizationPct, 0)}</MetricRow>
        <MetricRow label="Inquiries (12 months)">{result.inquiries12mo ?? dash}</MetricRow>
        <MetricRow label="Report date">{formatDate(result.reportDate)}</MetricRow>
      </div>

      <SubHeading>Tradelines</SubHeading>
      {result.tradelines && result.tradelines.length > 0 ? (
        <MiniTable
          headers={["Creditor", "Type", "Opened", "Balance", "Limit", "Util. %", "Payment status"]}
          caption="Tradelines"
        >
          {result.tradelines.map((tl, i) => (
            <tr key={`${tl.creditor}-${i}`}>
              <Td>{tl.creditor}</Td>
              <Td>{humanizeEnum(tl.type)}</Td>
              <Td>{formatDate(tl.openedDate)}</Td>
              <Td right>{formatCurrency(tl.balance)}</Td>
              <Td right>{formatCurrency(tl.creditLimit)}</Td>
              <Td right>{formatPct(tl.utilizationPct, 0)}</Td>
              <Td>{humanizeEnum(tl.paymentStatus)}</Td>
            </tr>
          ))}
        </MiniTable>
      ) : (
        <p className="text-sm text-muted">No tradelines reported.</p>
      )}

      <SubHeading>Collections and derogatories</SubHeading>
      {result.collections && result.collections.length > 0 ? (
        <MiniTable headers={["Type", "Amount", "Date"]} caption="Collections and derogatories">
          {result.collections.map((c, i) => (
            <tr key={`${c.type}-${i}`}>
              <Td>{humanizeEnum(c.type)}</Td>
              <Td right>{formatCurrency(c.amount)}</Td>
              <Td>{formatDate(c.date)}</Td>
            </tr>
          ))}
        </MiniTable>
      ) : (
        <p className="text-sm text-muted">None reported.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Income verification — §4.6.5 row 2 (variance > 10% flagged as discrepancy)
// ---------------------------------------------------------------------------

export function IncomeBody({ result }: { result: IncomeCheckResult }) {
  const discrepancy = result.employments.some(
    (r) => typeof r.variancePct === "number" && r.variancePct > 10,
  );
  return (
    <div>
      <MiniTable
        headers={[
          "Employer",
          "Verified",
          "Status",
          "Stated income",
          "Verified income",
          "Variance %",
          "Confidence",
        ]}
        caption="Income verification per employment"
      >
        {result.employments.map((row, i) => {
          const flagged = typeof row.variancePct === "number" && row.variancePct > 10;
          return (
            <tr key={`${row.employerName}-${i}`}>
              <Td>{row.employerName}</Td>
              <Td>
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                    row.employerVerified
                      ? "bg-success-soft text-success"
                      : "bg-danger-soft text-danger"
                  }`}
                >
                  {row.employerVerified ? "Yes" : "No"}
                </span>
              </Td>
              <Td>{row.employmentStatus ?? dash}</Td>
              <Td right>{formatCurrency(row.statedMonthlyIncome)}</Td>
              <Td right>{formatCurrency(row.verifiedMonthlyIncome)}</Td>
              <Td right>
                <span className={flagged ? "font-semibold text-danger" : undefined}>
                  {formatPct(row.variancePct)}
                </span>
              </Td>
              <Td right>{row.confidence ?? dash}</Td>
            </tr>
          );
        })}
      </MiniTable>
      {discrepancy ? (
        <p className="mt-2 text-sm font-semibold text-danger">
          Income variance above 10% — flagged as a discrepancy.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loan pricing — §4.6.5 row 4 (three scenarios + itemized adjustments)
// ---------------------------------------------------------------------------

const SCENARIO_LABELS: Record<string, string> = {
  par: "Par",
  "buy-down": "1-pt buy-down",
  "lender-credit": "Lender credit",
};

export function PricingBody({ result }: { result: PricingCheckResult }) {
  return (
    <div>
      <MetricRow label="Base rate">{formatRate(result.baseRate)}</MetricRow>

      <SubHeading>Rate scenarios</SubHeading>
      <div className="grid gap-3 sm:grid-cols-3">
        {result.scenarios.map((s) => (
          <div
            key={s.name}
            data-testid={`check-section-pricing-scenario-${s.name}`}
            className="rounded-md border border-line bg-paper/60 p-3"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {SCENARIO_LABELS[s.name] ?? humanizeEnum(s.name)}
            </p>
            <p className="mt-1 font-display text-xl font-bold text-ink">{formatRate(s.interestRate)}</p>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-soft">APR</dt>
                <dd className="font-semibold text-ink">{formatRate(s.apr)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-soft">Points / credits</dt>
                <dd className="font-semibold text-ink">{formatPoints(s.pointsOrCredits)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-soft">Monthly P&amp;I</dt>
                <dd className="font-semibold text-ink">{formatCurrency(s.monthlyPrincipalInterest)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-soft">Monthly PITI</dt>
                <dd className="font-semibold text-ink">{formatCurrency(s.monthlyPiti)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-soft">Origination cost</dt>
                <dd className="font-semibold text-ink">{formatCurrency(s.originationCost)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-soft">Closing cost</dt>
                <dd className="font-semibold text-ink">{formatCurrency(s.closingCost)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <SubHeading>Rate adjustment factors (itemized)</SubHeading>
      {result.scenarios[0]?.adjustments && result.scenarios[0].adjustments.length > 0 ? (
        <MiniTable headers={["Factor", "Adjustment"]} caption="Rate adjustment factors">
          {result.scenarios[0].adjustments.map((a, i) => (
            <tr key={`${a.factor}-${i}`}>
              <Td>{a.factor}</Td>
              <Td right>
                {a.amountPct > 0 ? "+" : ""}
                {formatPct(a.amountPct, 3)}
              </Td>
            </tr>
          ))}
        </MiniTable>
      ) : (
        <p className="text-sm text-muted">No adjustments applied.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AUS — §4.6.5 row 5 (recommendation, reasons, inputs used)
// ---------------------------------------------------------------------------

const AUS_LABELS: Record<string, string> = {
  "approve-eligible": "Approve/Eligible",
  refer: "Refer",
  "refer-with-caution": "Refer with Caution",
};

export function ausRecommendationLabel(value: string): string {
  return AUS_LABELS[value] ?? humanizeEnum(value);
}

export function AusBody({ result }: { result: AusCheckResult }) {
  return (
    <div>
      <MetricRow label="Recommendation">{ausRecommendationLabel(result.recommendation)}</MetricRow>
      <MetricRow label="Inputs used">
        DTI {formatPct(result.dtiUsed)} · LTV {formatPct(result.ltvUsed)} · middle score{" "}
        {result.middleScoreUsed ?? dash}
      </MetricRow>
      <SubHeading>Reasons</SubHeading>
      {result.reasons.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          {result.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No reasons reported.</p>
      )}
    </div>
  );
}
