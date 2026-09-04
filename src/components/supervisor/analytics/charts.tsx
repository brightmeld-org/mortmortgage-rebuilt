"use client";

// Hand-rolled SVG chart set for the supervisor AnalyticsDashboard (task-038).
// No chart libraries (profile allowlist) — same discipline as the increment-7
// keyless map. Frame anchor: frame/screen-analytics.png (chart vocabulary:
// line/area volume, status donut, bars, stacked bars, multi-line trend).
//
// Design rules applied (dataviz method):
//   - thin marks, 2px lines, 2px surface gaps between stacked segments,
//     recessive axes/grid, direct labels + legend for multi-series,
//     text in ink tokens (never the series color), native <title> tooltips.
//   - categorical palette below validated with the six-checks script
//     (lightness band, chroma, CVD separation, normal-vision floor, contrast
//     — all PASS on white); assigned in fixed order, never cycled.
//   - status hues (capacity green/yellow/red, approved/denied) come from the
//     app's semantic tokens and are never reused as series colors.

import type { ReactNode } from "react";

// Validated fixed-order categorical palette (trend lines).
export const SERIES_PALETTE = [
  "#2e5ea8",
  "#c26a24",
  "#0f8a6d",
  "#8d55c8",
  "#b0851a",
  "#c23a72",
  "#2a8fbd",
  "#5a7d1e",
] as const;

/** Overflow series beyond the fixed palette (identity via direct label). */
const SERIES_OVERFLOW = "#6b7684";

export function seriesColor(index: number): string {
  return index < SERIES_PALETTE.length ? SERIES_PALETTE[index] : SERIES_OVERFLOW;
}

// §4.5.1 workflow-state label → donut segment color (fixed per entity).
const STATE_LABEL_COLORS: Record<string, string> = {
  Draft: "#6b7684",
  "Application Received": "#2e5ea8",
  "Completeness & Consistency Validated": "#2a8fbd",
  "Supporting Documents Received": "#0f8a6d",
  "AUS Executed": "#8d55c8",
  "Preliminary Decision": "#b0851a",
  "Escalated Review": "#c26a24",
  "Conditional Approval": "#5a7d1e",
  Approved: "#2e7d4f",
  Denied: "#b3372b",
  "Borrower Notified": "#24425e",
  "Revision Requested": "#a97b12",
  Suspended: "#7a6a5a",
  Withdrawn: "#9a8f80",
  "Declined by Borrower": "#c23a72",
};

const CAPACITY_COLORS: Record<"green" | "yellow" | "red", string> = {
  green: "#2e7d4f",
  yellow: "#a97b12",
  red: "#b3372b",
};

const APPROVED_COLOR = "#2e7d4f";
const DENIED_COLOR = "#b3372b";
const AXIS_INK = "#6b7684";
const GRID = "#e4dfd4";

export interface SeriesPoint {
  label: string;
  value: number;
}

// ---------------------------------------------------------------------------
// Volume: line + area over time buckets
// ---------------------------------------------------------------------------

export function VolumeLineChart({ points, testId }: { points: SeriesPoint[]; testId: string }) {
  const width = 560;
  const height = 220;
  const pad = { top: 12, right: 14, bottom: 26, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;

  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = n > 0 ? `${path} L${x(n - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z` : "";

  // Sparse x labels: first, last, and ~3 between.
  const labelEvery = Math.max(1, Math.ceil(n / 5));
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => pad.top + innerH - f * innerH);

  return (
    <svg
      data-testid={testId}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label="Application volume over time"
    >
      {gridLines.map((gy, i) => (
        <line key={i} x1={pad.left} x2={width - pad.right} y1={gy} y2={gy} stroke={GRID} strokeWidth={1} />
      ))}
      <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke={AXIS_INK} strokeWidth={1} />
      {[0.5, 1].map((f) => (
        <text key={f} x={pad.left - 6} y={pad.top + innerH - f * innerH + 4} textAnchor="end" fontSize={10} fill={AXIS_INK}>
          {Math.round(f * max)}
        </text>
      ))}
      {n > 0 ? (
        <>
          <path d={area} fill="#24425e" opacity={0.08} />
          <path d={path} fill="none" stroke="#24425e" strokeWidth={2} strokeLinejoin="round" />
          {points.map((p, i) => (
            <g key={p.label}>
              <circle cx={x(i)} cy={y(p.value)} r={8} fill="transparent">
                <title>{`${p.label}: ${p.value}`}</title>
              </circle>
              {n <= 60 ? <circle cx={x(i)} cy={y(p.value)} r={2} fill="#24425e" /> : null}
              {i % labelEvery === 0 || i === n - 1 ? (
                <text
                  x={x(i)}
                  y={height - 8}
                  textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
                  fontSize={10}
                  fill={AXIS_INK}
                >
                  {p.label}
                </text>
              ) : null}
            </g>
          ))}
        </>
      ) : (
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill={AXIS_INK}>
          No submissions in range
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Status donut + legend
// ---------------------------------------------------------------------------

export function StatusDonutChart({
  rows,
  testId,
}: {
  rows: Array<{ label: string; count: number }>;
  testId: string;
}) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const size = 180;
  const c = size / 2;
  const rOuter = 84;
  const rInner = 50;

  let angle = -Math.PI / 2;
  const segments = rows
    .filter((r) => r.count > 0)
    .map((r) => {
      const frac = total > 0 ? r.count / total : 0;
      const start = angle;
      const end = angle + frac * Math.PI * 2;
      angle = end;
      return { ...r, start, end };
    });

  function arcPath(start: number, end: number): string {
    const large = end - start > Math.PI ? 1 : 0;
    const x0 = c + rOuter * Math.cos(start);
    const y0 = c + rOuter * Math.sin(start);
    const x1 = c + rOuter * Math.cos(end);
    const y1 = c + rOuter * Math.sin(end);
    const x2 = c + rInner * Math.cos(end);
    const y2 = c + rInner * Math.sin(end);
    const x3 = c + rInner * Math.cos(start);
    const y3 = c + rInner * Math.sin(start);
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${rOuter},${rOuter} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${rInner},${rInner} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
  }

  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-4">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-44 w-44 shrink-0" role="img" aria-label="Status breakdown donut">
        {segments.length === 1 ? (
          <circle cx={c} cy={c} r={(rOuter + rInner) / 2} fill="none" strokeWidth={rOuter - rInner} stroke={STATE_LABEL_COLORS[segments[0].label] ?? "#6b7684"}>
            <title>{`${segments[0].label}: ${segments[0].count}`}</title>
          </circle>
        ) : (
          segments.map((s) => (
            <path key={s.label} d={arcPath(s.start, s.end)} fill={STATE_LABEL_COLORS[s.label] ?? "#6b7684"} stroke="#ffffff" strokeWidth={2}>
              <title>{`${s.label}: ${s.count}`}</title>
            </path>
          ))
        )}
        <text x={c} y={c - 2} textAnchor="middle" fontSize={22} fontWeight={700} fill="#1d2733">
          {total}
        </text>
        <text x={c} y={c + 16} textAnchor="middle" fontSize={9} fill={AXIS_INK}>
          IN RANGE
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: STATE_LABEL_COLORS[r.label] ?? "#6b7684" }} />
            <span className="truncate text-ink-soft">{r.label}</span>
            <span className="ml-auto font-medium tabular-nums text-ink">{r.count}</span>
          </li>
        ))}
        {rows.length === 0 ? <li className="text-muted">No applications in range</li> : null}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars (loan type / property type — single hue)
// ---------------------------------------------------------------------------

export function HorizontalBarChart({
  rows,
  testId,
  color = "#24425e",
}: {
  rows: SeriesPoint[];
  testId: string;
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div data-testid={testId} className="space-y-1.5">
      {rows.length === 0 ? <p className="text-xs text-muted">No applications in range</p> : null}
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-36 shrink-0 truncate text-right text-ink-soft" title={r.label}>
            {r.label}
          </span>
          <span className="relative h-4 flex-1 overflow-hidden rounded-r-[4px] bg-paper">
            <span
              className="absolute inset-y-0 left-0 rounded-r-[4px]"
              style={{ width: `${(r.value / max) * 100}%`, backgroundColor: color }}
              title={`${r.label}: ${r.value}`}
            />
          </span>
          <span className="w-8 shrink-0 text-right font-medium tabular-nums text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workload distribution (capacity coloring — semantic status hues)
// ---------------------------------------------------------------------------

export function WorkloadBarChart({
  rows,
  thresholds,
  testId,
}: {
  rows: Array<{ caseworkerName: string; activeAssignments: number; capacityColor: "green" | "yellow" | "red" }>;
  thresholds: { yellow: number; red: number } | null;
  testId: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.activeAssignments));
  return (
    <div data-testid={testId}>
      <div className="space-y-1.5">
        {rows.length === 0 ? <p className="text-xs text-muted">No active caseworkers</p> : null}
        {rows.map((r) => (
          <div key={r.caseworkerName} className="flex items-center gap-2 text-xs" data-testid={`analytics-workload-row-${r.caseworkerName.replace(/\s+/g, "-").toLowerCase()}`}>
            <span className="w-36 shrink-0 truncate text-right text-ink-soft" title={r.caseworkerName}>
              {r.caseworkerName}
            </span>
            <span className="relative h-4 flex-1 overflow-hidden rounded-r-[4px] bg-paper">
              <span
                className="absolute inset-y-0 left-0 rounded-r-[4px]"
                data-capacity={r.capacityColor}
                style={{ width: `${(r.activeAssignments / max) * 100}%`, backgroundColor: CAPACITY_COLORS[r.capacityColor] }}
                title={`${r.caseworkerName}: ${r.activeAssignments} active (${r.capacityColor})`}
              />
            </span>
            <span className="w-8 shrink-0 text-right font-medium tabular-nums text-ink">{r.activeAssignments}</span>
          </div>
        ))}
      </div>
      {thresholds ? (
        <p className="mt-2 text-[11px] text-muted">
          Capacity coloring: green &lt; {thresholds.yellow} · yellow {thresholds.yellow}–{thresholds.red - 1} · red ≥ {thresholds.red} (configurable in Settings)
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked approved/denied bands (LTV / DTI risk)
// ---------------------------------------------------------------------------

export function RiskStackedBarChart({
  rows,
  testId,
}: {
  rows: Array<{ band: string; approvedCount: number; deniedCount: number }>;
  testId: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.approvedCount + r.deniedCount));
  return (
    <div data-testid={testId}>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const total = r.approvedCount + r.deniedCount;
          return (
            <div key={r.band} className="flex items-center gap-2 text-xs">
              <span className="w-16 shrink-0 text-right text-ink-soft">{r.band}</span>
              <span className="flex h-4 flex-1 items-stretch gap-[2px] overflow-hidden">
                {r.approvedCount > 0 ? (
                  <span
                    className="rounded-r-[2px]"
                    style={{ width: `${(r.approvedCount / max) * 100}%`, backgroundColor: APPROVED_COLOR }}
                    title={`${r.band} approved: ${r.approvedCount}`}
                  />
                ) : null}
                {r.deniedCount > 0 ? (
                  <span
                    className="rounded-r-[2px]"
                    style={{ width: `${(r.deniedCount / max) * 100}%`, backgroundColor: DENIED_COLOR }}
                    title={`${r.band} denied: ${r.deniedCount}`}
                  />
                ) : null}
                {total === 0 ? <span className="h-full w-[2px] bg-line" /> : null}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-ink">
                {r.approvedCount}/{r.deniedCount}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: APPROVED_COLOR }} /> Approved
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: DENIED_COLOR }} /> Denied
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6-month per-caseworker multi-line trend
// ---------------------------------------------------------------------------

export interface TrendSeries {
  name: string;
  /** One value per month bucket, in month order. */
  values: number[];
}

export function TrendLineChart({
  months,
  series,
  testId,
}: {
  /** Month labels in order (e.g. "Mar 2026"). */
  months: string[];
  series: TrendSeries[];
  testId: string;
}) {
  const width = 560;
  const height = 230;
  const pad = { top: 12, right: 110, bottom: 26, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = months.length;

  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  // Direct labels at line ends, pushed apart so converging lines stay legible.
  const labelYs: number[] = series.map((s) => y(s.values[s.values.length - 1] ?? 0) + 3);
  const order = labelYs.map((_, i) => i).sort((a, b) => labelYs[a] - labelYs[b]);
  for (let k = 1; k < order.length; k += 1) {
    const prev = order[k - 1];
    const cur = order[k];
    if (labelYs[cur] - labelYs[prev] < 11) labelYs[cur] = labelYs[prev] + 11;
  }

  // Axis gridline labels, deduped when max is small enough that halves collide.
  const axisTicks = Math.round(0.5 * max) === max ? [1] : [0.5, 1];

  return (
    <div data-testid={testId}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Completed applications per caseworker per month">
        {axisTicks.map((f) => (
          <line key={f} x1={pad.left} x2={width - pad.right} y1={pad.top + innerH - f * innerH} y2={pad.top + innerH - f * innerH} stroke={GRID} strokeWidth={1} />
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke={AXIS_INK} strokeWidth={1} />
        {axisTicks.map((f) => (
          <text key={f} x={pad.left - 6} y={pad.top + innerH - f * innerH + 4} textAnchor="end" fontSize={10} fill={AXIS_INK}>
            {Math.round(f * max)}
          </text>
        ))}
        {months.map((m, i) => (
          <text key={m} x={x(i)} y={height - 8} textAnchor="middle" fontSize={10} fill={AXIS_INK}>
            {m}
          </text>
        ))}
        {series.map((s, si) => {
          const color = seriesColor(si);
          const path = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          return (
            <g key={s.name}>
              <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
              {s.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r={8} fill="transparent">
                  <title>{`${s.name} — ${months[i]}: ${v}`}</title>
                </circle>
              ))}
              {s.values.map((v, i) => (
                <circle key={`d${i}`} cx={x(i)} cy={y(v)} r={2.5} fill={color} stroke="#ffffff" strokeWidth={1} />
              ))}
              {/* Direct label at line end (collision-spread) — identity never color-alone. */}
              <text x={width - pad.right + 6} y={labelYs[si]} fontSize={10} fill="#4c5a68">
                {s.name.length > 16 ? `${s.name.slice(0, 15)}…` : s.name}
              </text>
            </g>
          );
        })}
        {series.length === 0 ? (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill={AXIS_INK}>
            No completed applications in the trend window
          </text>
        ) : null}
      </svg>
      {series.length > 1 ? (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          {series.map((s, si) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: seriesColor(si) }} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart card wrapper with per-element CSV download (frame: "CSV" per chart)
// ---------------------------------------------------------------------------

export function ChartCard({
  title,
  csvHref,
  csvTestId,
  children,
  extra,
}: {
  title: string;
  csvHref: string;
  csvTestId: string;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
        <div className="flex items-center gap-2">
          {extra}
          <a
            href={csvHref}
            download
            data-testid={csvTestId}
            className="rounded-md border border-line px-2 py-0.5 text-xs font-medium text-ink-soft transition-colors duration-200 hover:border-navy hover:text-navy"
          >
            Download CSV
          </a>
        </div>
      </div>
      {children}
    </section>
  );
}
