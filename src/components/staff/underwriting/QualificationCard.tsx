"use client";

// Qualification summary card (task-026, §4.6.5 bullet, REQ-059/NFR-008):
// middle credit score with tier, DTI, LTV and CLTV, estimated monthly PITI,
// AUS recommendation, escalation required (yes/no with criteria met), overall
// status. Values come byte-for-byte from GET /api/applications/:id/qualification
// — every metric element carries the RAW wire value in data-value so the
// rendered card is verifiable against the API response.
//
// Selector contract: qualification-{metric} where metric = the §A
// QualificationSummary field name (middleCreditScore, creditTier, dti, ltv,
// cltv, estimatedMonthlyPiti, ausRecommendation, escalationRequired,
// escalationCriteriaMet, overallStatus).

import type { ReactNode } from "react";
import { formatCurrency, humanizeEnum } from "@/components/borrower/format";
import { ApiErrorBanner, Card, CardHeading, SkeletonBlock, btnOutline } from "@/components/borrower/ui";
import { ausRecommendationLabel, formatPct } from "./check-bodies";
import type { QualificationStatus, QualificationSummary } from "./types";

const STATUS_META: Record<QualificationStatus, { label: string; className: string }> = {
  qualified: { label: "Qualified", className: "bg-success-soft text-success" },
  review: { label: "Review", className: "bg-warn-soft text-warn" },
  "not-qualified": { label: "Not qualified", className: "bg-danger-soft text-danger" },
};

function Metric({
  metric,
  label,
  raw,
  children,
}: {
  metric: string;
  label: string;
  /** Raw wire value (stringified) for byte-for-byte verification. */
  raw: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={`qualification-${metric}`} data-value={raw}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-0.5 font-display text-xl font-bold text-ink">{children}</p>
    </div>
  );
}

export function QualificationCard({
  summary,
  loading,
  error,
  onRetry,
}: {
  summary: QualificationSummary | null;
  loading: boolean;
  error: { message: string; details?: string[] } | null;
  onRetry: () => void;
}) {
  return (
    <Card testId="qualification-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardHeading>Qualification summary</CardHeading>
        {summary ? (
          <span
            data-testid="qualification-overallStatus"
            data-value={summary.overallStatus}
            className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${STATUS_META[summary.overallStatus].className}`}
          >
            {STATUS_META[summary.overallStatus].label}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-4">
          <SkeletonBlock className="h-16 w-full" />
        </div>
      ) : error ? (
        <div className="mt-4">
          <ApiErrorBanner message={error.message} details={error.details} testId="qualification-error" />
          <button type="button" data-testid="qualification-reload" onClick={onRetry} className={btnOutline}>
            Retry
          </button>
        </div>
      ) : summary ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
            <Metric
              metric="middleCreditScore"
              label="Middle score"
              raw={summary.middleCreditScore !== undefined ? String(summary.middleCreditScore) : ""}
            >
              {summary.middleCreditScore ?? "—"}
              {summary.creditTier ? (
                <span
                  data-testid="qualification-creditTier"
                  data-value={summary.creditTier}
                  className="ml-1.5 align-middle text-sm font-semibold text-ink-soft"
                >
                  · {humanizeEnum(summary.creditTier)}
                </span>
              ) : null}
            </Metric>
            <Metric metric="dti" label="DTI" raw={summary.dti !== undefined ? String(summary.dti) : ""}>
              {formatPct(summary.dti)}
            </Metric>
            <Metric metric="ltv" label="LTV" raw={summary.ltv !== undefined ? String(summary.ltv) : ""}>
              {formatPct(summary.ltv)}
            </Metric>
            <Metric metric="cltv" label="CLTV" raw={summary.cltv !== undefined ? String(summary.cltv) : ""}>
              {formatPct(summary.cltv)}
            </Metric>
            <Metric
              metric="estimatedMonthlyPiti"
              label="Est. monthly PITI"
              raw={summary.estimatedMonthlyPiti !== undefined ? String(summary.estimatedMonthlyPiti) : ""}
            >
              {formatCurrency(summary.estimatedMonthlyPiti)}
            </Metric>
            <Metric
              metric="ausRecommendation"
              label="AUS recommendation"
              raw={summary.ausRecommendation ?? ""}
            >
              {summary.ausRecommendation ? (
                <span className="text-base">{ausRecommendationLabel(summary.ausRecommendation)}</span>
              ) : (
                "—"
              )}
            </Metric>
          </div>

          <div
            data-testid="qualification-escalationRequired"
            data-value={String(summary.escalationRequired)}
            className={`mt-4 rounded-md border px-3.5 py-2.5 text-sm ${
              summary.escalationRequired
                ? "border-warn/40 bg-warn-soft text-warn"
                : "border-line bg-paper/60 text-ink-soft"
            }`}
          >
            <p className="font-semibold">
              Escalation required: {summary.escalationRequired ? "Yes" : "No"}
            </p>
            {summary.escalationCriteriaMet && summary.escalationCriteriaMet.length > 0 ? (
              <ul
                data-testid="qualification-escalationCriteriaMet"
                data-value={JSON.stringify(summary.escalationCriteriaMet)}
                className="mt-1 list-disc pl-5"
              >
                {summary.escalationCriteriaMet.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            ) : (
              <p
                data-testid="qualification-escalationCriteriaMet"
                data-value={JSON.stringify(summary.escalationCriteriaMet ?? [])}
                className="mt-1"
              >
                No escalation criteria met.
              </p>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}
