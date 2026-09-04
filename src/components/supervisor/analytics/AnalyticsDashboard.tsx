"use client";

// AnalyticsDashboard (contracts §C, task-038, REQ-062 / NFR-015 / NFR-024) —
// /supervisor/analytics: every §4.6.8 element with the date-range filter
// (default last 12 months) applying to all charts and a per-element
// "Download CSV". Frame anchor: frame/screen-analytics.png + gui-spec
// §sup-analytics; key states: loading / populated.
//
// Data: GET /api/supervisor/analytics?from&to (all figures DB-aggregated
// server-side — SEC-14). Capacity-threshold caption reads the live §4.6.11
// values from GET /api/admin/config (workload.capacityYellow / capacityRed).
//
// Volume toggle: the server serves daily submission counts; weekly (ISO week,
// Monday start) and monthly buckets are folded client-side — both grains are
// exact aggregations of the same server aggregate.
//
// Selector contract (namespace established this increment, logged in
// frame-extensions.md): analytics-date-from, analytics-date-to,
// analytics-csv-{element}, analytics-summary-{metric},
// analytics-chart-{element}, analytics-volume-toggle-{grain},
// analytics-pending-row-{applicationId}, analytics-feed-item-{n},
// analytics-compliance-table, analytics-loading, analytics-error.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getJson, type ErrorResponseBody } from "@/components/borrower/api";
import { ApiErrorBanner, SkeletonBlock } from "@/components/borrower/ui";
import { formatCurrency } from "@/components/borrower/format";
import {
  ChartCard,
  HorizontalBarChart,
  RiskStackedBarChart,
  StatusDonutChart,
  TrendLineChart,
  VolumeLineChart,
  WorkloadBarChart,
  type SeriesPoint,
  type TrendSeries,
} from "@/components/supervisor/analytics/charts";

// --- Wire shapes (contracts.json, field names verbatim) ---

interface AnalyticsSummary {
  totalApplications: number;
  applicationsThisMonth: number;
  approvalRatePct: number;
  averageLoanAmount: number;
  averageDaysToDecision: number;
  overdueCount: number;
}
interface VolumePoint {
  period: string;
  count: number;
}
interface LabelCount {
  label: string;
  count: number;
}
interface WorkloadRow {
  caseworkerName: string;
  activeAssignments: number;
  capacityColor: "green" | "yellow" | "red";
}
interface RiskBand {
  band: string;
  approvedCount: number;
  deniedCount: number;
}
interface TrendPoint {
  month: string;
  caseworkerName: string;
  completedCount: number;
}
interface ComplianceRow {
  caseworkerName: string;
  activeCount: number;
  overdueCount: number;
  atRiskCount: number;
  pendingApprovalsAwaiting: number;
  avgDaysInState: number;
  correctionsMade: number;
  revisionRequestsIssued: number;
  completedInPeriod: number;
  approvalRatePct: number;
}
interface PendingApprovalRow {
  applicationId: string;
  applicationNumber: string;
  workflowState: string;
  daysWaiting: number;
  eligibleApproverNote: string;
}
interface ActivityEvent {
  occurredAt: string;
  eventType: string;
  applicationNumber?: string;
  description: string;
}
interface AnalyticsDashboardResponse {
  summary: AnalyticsSummary;
  volume: VolumePoint[];
  statusBreakdown: LabelCount[];
  loanTypeBreakdown: LabelCount[];
  propertyTypeBreakdown: LabelCount[];
  workload: WorkloadRow[];
  ltvRisk: RiskBand[];
  dtiRisk: RiskBand[];
  performanceTrend: TrendPoint[];
  compliance: ComplianceRow[];
  pendingApprovals: PendingApprovalRow[];
  activityFeed: ActivityEvent[];
}
interface SystemConfigResponse {
  settings: Array<{ key: string; value: string }>;
}

// §4.5.1 labels for the pending-approvals states (server keeps the full map).
const PENDING_STATE_LABELS: Record<string, string> = {
  preliminary_decision: "Preliminary Decision",
  escalated_review: "Escalated Review",
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - 12);
  return { from: isoDate(from), to: isoDate(to) };
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

/** Fold daily volume points into monthly buckets, zero-filled across the range. */
function monthlyBuckets(points: VolumePoint[], from: string, to: string): SeriesPoint[] {
  const counts = new Map<string, number>();
  for (const p of points) {
    const key = p.period.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + p.count);
  }
  const out: SeriesPoint[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.getTime() <= end.getTime() && out.length < 40) {
    const key = cursor.toISOString().slice(0, 7);
    out.push({ label: monthLabel(key), value: counts.get(key) ?? 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/** Fold daily points into ISO weeks (Monday start), zero-filled. */
function weeklyBuckets(points: VolumePoint[], from: string, to: string): SeriesPoint[] {
  function weekStart(dateStr: string): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const day = d.getUTCDay(); // 0 Sun … 6 Sat
    d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    return isoDate(d);
  }
  const counts = new Map<string, number>();
  for (const p of points) {
    const key = weekStart(p.period);
    counts.set(key, (counts.get(key) ?? 0) + p.count);
  }
  const out: SeriesPoint[] = [];
  const cursor = new Date(`${weekStart(from)}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime() && out.length < 160) {
    const key = isoDate(cursor);
    const label = `${MONTH_NAMES[cursor.getUTCMonth()]} ${cursor.getUTCDate()}`;
    out.push({ label, value: counts.get(key) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SummaryTile({
  value,
  label,
  testId,
  accent,
}: {
  value: string;
  label: string;
  testId: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-3 shadow-sm" data-testid={testId}>
      <p className={`font-display text-2xl font-bold ${accent ? "text-danger" : "text-ink"}`}>{value}</p>
      <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}

export function AnalyticsDashboard() {
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState<AnalyticsDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  const [grain, setGrain] = useState<"weekly" | "monthly">("monthly");
  const [thresholds, setThresholds] = useState<{ yellow: number; red: number } | null>(null);

  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const reload = useCallback(async () => {
    setLoading(true);
    const result = await getJson<AnalyticsDashboardResponse>(`/api/supervisor/analytics?${query}`);
    setLoading(false);
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
  }, [query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void (async () => {
      const result = await getJson<SystemConfigResponse>("/api/admin/config");
      if (!result.ok) return; // caption falls back to the generic wording
      const num = (key: string): number | null => {
        const row = result.data.settings.find((s) => s.key === key);
        if (!row) return null;
        try {
          const parsed = JSON.parse(row.value) as unknown;
          return typeof parsed === "number" ? parsed : null;
        } catch {
          return null;
        }
      };
      const yellow = num("workload.capacityYellow");
      const red = num("workload.capacityRed");
      if (yellow !== null && red !== null) setThresholds({ yellow, red });
    })();
  }, []);

  const csvHref = (element: string) => `/api/supervisor/analytics/${element}/csv?${query}`;

  const volumeBuckets = useMemo(
    () => (data ? (grain === "monthly" ? monthlyBuckets(data.volume, from, to) : weeklyBuckets(data.volume, from, to)) : []),
    [data, grain, from, to],
  );

  const trend = useMemo((): { months: string[]; series: TrendSeries[] } => {
    if (!data) return { months: [], series: [] };
    const monthKeys = [...new Set(data.performanceTrend.map((p) => p.month))].sort();
    const names = [...new Set(data.performanceTrend.map((p) => p.caseworkerName))];
    const byKey = new Map(data.performanceTrend.map((p) => [`${p.month}|${p.caseworkerName}`, p.completedCount]));
    return {
      months: monthKeys.map(monthLabel),
      series: names.map((name) => ({
        name,
        values: monthKeys.map((m) => byKey.get(`${m}|${name}`) ?? 0),
      })),
    };
  }, [data]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Analytics</h1>
          <p className="mt-1 text-sm text-muted">
            All figures are computed by database aggregation over the selected date range.
          </p>
        </div>
        {/* Date-range filter — applies to all elements (default last 12 months). */}
        <div className="flex items-end gap-2">
          <label className="text-xs font-medium text-ink-soft">
            From
            <input
              type="date"
              data-testid="analytics-date-from"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-0.5 block rounded-md border border-line bg-card px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="text-xs font-medium text-ink-soft">
            To
            <input
              type="date"
              data-testid="analytics-date-to"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="mt-0.5 block rounded-md border border-line bg-card px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <a
            href={csvHref("summary")}
            download
            data-testid="analytics-csv-summary"
            className="rounded-md border border-line px-2 py-1.5 text-xs font-medium text-ink-soft transition-colors duration-200 hover:border-navy hover:text-navy"
          >
            Summary CSV
          </a>
        </div>
      </div>

      {error ? (
        <ApiErrorBanner message={error.message} details={error.details} testId="analytics-error" />
      ) : null}

      {loading || data === null ? (
        <div data-testid="analytics-loading" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <SkeletonBlock key={i} className="h-20" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <SkeletonBlock className="h-64" />
            <SkeletonBlock className="h-64" />
            <SkeletonBlock className="h-64" />
            <SkeletonBlock className="h-64" />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary metrics row (§4.6.8) */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryTile
              value={String(data.summary.totalApplications)}
              label="Total applications"
              testId="analytics-summary-total"
            />
            <SummaryTile
              value={String(data.summary.applicationsThisMonth)}
              label="This month"
              testId="analytics-summary-this-month"
            />
            <SummaryTile
              value={`${data.summary.approvalRatePct}%`}
              label="Approval rate"
              testId="analytics-summary-approval-rate"
            />
            <SummaryTile
              value={formatCurrency(data.summary.averageLoanAmount)}
              label="Avg loan amount"
              testId="analytics-summary-avg-loan"
            />
            <SummaryTile
              value={String(data.summary.averageDaysToDecision)}
              label="Avg days to decision"
              testId="analytics-summary-avg-days"
            />
            <SummaryTile
              value={String(data.summary.overdueCount)}
              label="Overdue"
              testId="analytics-summary-overdue"
              accent={data.summary.overdueCount > 0}
            />
          </div>

          {/* Charts grid */}
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Volume over time"
              csvHref={csvHref("volume")}
              csvTestId="analytics-csv-volume"
              extra={
                <span className="flex overflow-hidden rounded-md border border-line text-xs font-medium">
                  {(["monthly", "weekly"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      data-testid={`analytics-volume-toggle-${g}`}
                      aria-pressed={grain === g}
                      onClick={() => setGrain(g)}
                      className={`px-2 py-0.5 transition-colors duration-200 ${
                        grain === g ? "bg-navy text-white" : "bg-card text-ink-soft hover:text-navy"
                      }`}
                    >
                      {g === "monthly" ? "Monthly" : "Weekly"}
                    </button>
                  ))}
                </span>
              }
            >
              <VolumeLineChart points={volumeBuckets} testId="analytics-chart-volume" />
            </ChartCard>

            <ChartCard title="Status breakdown" csvHref={csvHref("status")} csvTestId="analytics-csv-status">
              <StatusDonutChart rows={data.statusBreakdown} testId="analytics-chart-status" />
            </ChartCard>

            <ChartCard title="Loan type breakdown" csvHref={csvHref("loan-type")} csvTestId="analytics-csv-loan-type">
              <HorizontalBarChart
                rows={data.loanTypeBreakdown.map((r) => ({ label: r.label, value: r.count }))}
                testId="analytics-chart-loan-type"
              />
            </ChartCard>

            <ChartCard
              title="Property type breakdown"
              csvHref={csvHref("property-type")}
              csvTestId="analytics-csv-property-type"
            >
              <HorizontalBarChart
                rows={data.propertyTypeBreakdown.map((r) => ({ label: r.label, value: r.count }))}
                testId="analytics-chart-property-type"
                color="#2b5e8c"
              />
            </ChartCard>

            <ChartCard
              title="Workload per caseworker"
              csvHref={csvHref("workload")}
              csvTestId="analytics-csv-workload"
            >
              <WorkloadBarChart rows={data.workload} thresholds={thresholds} testId="analytics-chart-workload" />
            </ChartCard>

            <ChartCard
              title="LTV risk — approved vs denied"
              csvHref={csvHref("ltv-risk")}
              csvTestId="analytics-csv-ltv-risk"
            >
              <RiskStackedBarChart rows={data.ltvRisk} testId="analytics-chart-ltv-risk" />
            </ChartCard>

            <ChartCard
              title="DTI risk — approved vs denied"
              csvHref={csvHref("dti-risk")}
              csvTestId="analytics-csv-dti-risk"
            >
              <RiskStackedBarChart rows={data.dtiRisk} testId="analytics-chart-dti-risk" />
            </ChartCard>

            <ChartCard
              title="Performance trend (6 months)"
              csvHref={csvHref("performance-trend")}
              csvTestId="analytics-csv-performance-trend"
            >
              <TrendLineChart months={trend.months} series={trend.series} testId="analytics-chart-performance-trend" />
            </ChartCard>
          </div>

          {/* Compliance table + right rail (frame layout) */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ChartCard
                title="Caseworker compliance"
                csvHref={csvHref("compliance")}
                csvTestId="analytics-csv-compliance"
              >
                {/* Scrollable data region — keyboard-operable (AC-60): focusable,
                    named, visible focus ring per the app focus convention. */}
                <div
                  className="overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40"
                  tabIndex={0}
                  role="region"
                  aria-label="Caseworker compliance table"
                >
                  <table className="w-full text-left text-sm" data-testid="analytics-compliance-table">
                    <thead>
                      <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                        <th className="px-2 py-2">Caseworker</th>
                        <th className="px-2 py-2 text-right">Active</th>
                        <th className="px-2 py-2 text-right">Overdue</th>
                        <th className="px-2 py-2 text-right">At risk</th>
                        <th className="px-2 py-2 text-right">Pending approvals awaiting</th>
                        <th className="px-2 py-2 text-right">Avg days in state</th>
                        <th className="px-2 py-2 text-right">Corrections made</th>
                        <th className="px-2 py-2 text-right">Revision requests issued</th>
                        <th className="px-2 py-2 text-right">Completed (period)</th>
                        <th className="px-2 py-2 text-right">Approval rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.compliance.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="px-2 py-6 text-center text-sm text-muted">
                            No caseworkers to report on.
                          </td>
                        </tr>
                      ) : (
                        data.compliance.map((row) => (
                          <tr key={row.caseworkerName} className="border-b border-line last:border-b-0">
                            <td className="px-2 py-2 font-medium text-ink">{row.caseworkerName}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{row.activeCount}</td>
                            <td className={`px-2 py-2 text-right tabular-nums ${row.overdueCount > 0 ? "font-semibold text-danger" : ""}`}>
                              {row.overdueCount}
                            </td>
                            <td className={`px-2 py-2 text-right tabular-nums ${row.atRiskCount > 0 ? "text-warn" : ""}`}>
                              {row.atRiskCount}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{row.pendingApprovalsAwaiting}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{row.avgDaysInState}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{row.correctionsMade}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{row.revisionRequestsIssued}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{row.completedInPeriod}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{row.approvalRatePct}%</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </ChartCard>
            </div>

            <div className="space-y-4">
              <ChartCard
                title="Pending approvals"
                csvHref={csvHref("pending-approvals")}
                csvTestId="analytics-csv-pending-approvals"
              >
                {data.pendingApprovals.length === 0 ? (
                  <p className="text-xs text-muted">No applications awaiting approval.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {data.pendingApprovals.map((row) => (
                      <li key={row.applicationId}>
                        <a
                          href={`/staff/applications/${row.applicationId}`}
                          data-testid={`analytics-pending-row-${row.applicationId}`}
                          className="block rounded-md px-2 py-1.5 transition-colors duration-200 hover:bg-paper"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-medium text-navy">{row.applicationNumber}</span>
                            <span className="whitespace-nowrap text-xs tabular-nums text-ink-soft">
                              {row.daysWaiting} {row.daysWaiting === 1 ? "day" : "days"}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-xs text-ink-soft">
                            {PENDING_STATE_LABELS[row.workflowState] ?? row.workflowState} · {row.eligibleApproverNote}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </ChartCard>

              <ChartCard title="Recent activity" csvHref={csvHref("activity")} csvTestId="analytics-csv-activity">
                {data.activityFeed.length === 0 ? (
                  <p className="text-xs text-muted">No activity in range.</p>
                ) : (
                  <div
                    className="max-h-96 overflow-y-auto rounded-md pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40"
                    tabIndex={0}
                    role="region"
                    aria-label="Recent activity feed"
                  >
                    <ul className="space-y-1.5 text-xs">
                    {data.activityFeed.map((event, n) => (
                      <li
                        key={`${event.occurredAt}-${n}`}
                        data-testid={`analytics-feed-item-${n}`}
                        className="border-b border-line pb-1.5 last:border-b-0"
                      >
                        <span className="text-ink">
                          {event.applicationNumber ? (
                            <span className="font-medium text-navy">{event.applicationNumber}: </span>
                          ) : null}
                          {event.description}
                        </span>
                        <span className="ml-1 whitespace-nowrap text-muted" title={event.occurredAt}>
                          · {relativeTime(event.occurredAt)}
                        </span>
                      </li>
                    ))}
                    </ul>
                  </div>
                )}
              </ChartCard>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
